"use strict";

var db = require('../helpers/db');
var Promise = require('bluebird');
var sync_model = require('./sync');
var vlad = require('../helpers/validator');
var error = require('../helpers/error');
var invite_model = require('./invite');

vlad.define('space', {
	id: {type: vlad.type.client_id, required: true},
	user_id: {type: vlad.type.int, required: true},
	body: {type: vlad.type.string},
});

// our roles
var roles = {
	owner: 'owner',
	admin: 'admin',
	moderator: 'moderator',
	member: 'member',
	guest: 'guest',
};
// permissions enum for actions allowed inside of a space
var permissions = {
	// spaces
	edit_space: 'edit-space',
	delete_space: 'delete-space',
	set_space_owner: 'set-space-owner',
	add_space_invite: 'add-space-invite',
	edit_space_invite: 'edit-space-invite',
	delete_space_invite: 'delete-space-invite',

	// boards
	add_board: 'add-board',
	edit_board: 'edit-board',
	delete_board: 'delete-board',

	// notes
	add_note: 'add-note',
	edit_note: 'edit-note',
	delete_note: 'delete-note',
};
// make a catch-all admin role that has all but a few permissions
var admin_role = Object.keys(permissions).map(function(key) {
	// some space actions are above admins
	if(['set_space_owner', 'delete_space'].indexOf(key) >= 0) return;
	return permissions[key];
});
// assign individual permissions for each role
var role_permissions = {
	owner: admin_role.concat([
		permissions.set_space_owner,
		permissions.delete_space,
	]),
	admin: admin_role,
	moderator: [
		permissions.add_board,
		permissions.edit_board,
		permissions.delete_board,
		permissions.add_note,
		permissions.edit_note,
		permissions.delete_note,
	],
	member: [
		permissions.add_note,
		permissions.edit_note,
		permissions.delete_note,
	],
	guest: [],	// haha read only suckerrrrAHAHAAHGGGGGGGGRRRRRGRYTHADJK;
};
exports.permissions = permissions;
exports.roles = roles;

/**
 * make sure the given user has the ability to perform the given action. this
 * function throws a forbidden error if the user doesn't have access. if you
 * want a boolean yes/no, see user_has_permission()
 */
exports.permissions_check = function(user_id, space_id, permission) {
	return get_space_user_record(user_id, space_id)
		.then(function(space_user) {
			if(!space_user) throw error.forbidden('you don\'t have access to space '+space_id);
			var role = space_user.role;
			var permissions = role_permissions[role];
			if(permissions.indexOf(permission) >= 0) return true;
			throw error.forbidden('you don\'t have `'+permission+'` permissions on space '+space_id);
		});
};

/**
 * wraps permissions_check, and catches errors to return a boolean true/false
 */
exports.user_has_permission = function(user_id, space_id, permission) {
	return exports.permissions_check(user_id, space_id, permission)
		.then(function() {
			return true;
		})
		// catch `forbidden` errors and return false
		.catch(function(err) { return err.status == 403 && err.app_error === true; }, function(err) {
			return false;
		});
};

/**
 * does this user have any kind of access to this space? anyone who has access
 * to the space can READ anything in the space, regardless of permissions (ie,
 * guest permissions).
 */
exports.user_is_in_space = function(user_id, space_id) {
	return get_space_user_record(user_id, space_id);
};

/**
 * populates member data for a set of spaces
 */
var populate_members = function(spaces, options) {
	options || (options = {});
	var skip_invites = options.skip_invites;

	if(spaces.length == 0) return Promise.resolve(spaces);
	var space_ids = spaces.map(function(s) { return s.id; });
	var invite_promise = skip_invites ?
		Promise.resolve([]) :
		invite_model.get_by_spaces_ids(space_ids);
	var promises = [
		db.by_ids('spaces_users', space_ids, {id_field: 'space_id'}),
		invite_promise,
	];
	return Promise.all(promises)
		.spread(function(space_users, space_invites) {
			var space_idx = {};
			spaces.forEach(function(space) { space_idx[space.id] = space; });

			space_users.forEach(function(user) {
				var space = space_idx[user.space_id];
				if(!space) return;
				if(!space.data) space.data = {};
				if(!space.data.members) space.data.members = [];
				space.data.members.push(user);
			});
			space_invites.forEach(function(invite) {
				var space = space_idx[invite.space_id];
				if(!space) return;
				if(!space.data) space.data = {};
				if(!space.data.invites) space.data.invites = [];
				space.data.invites.push(invite);
			});
			return spaces;
		});
};

/**
 * grab a space by id
 */
var get_by_id = function(space_id, options) {
	options || (options = {});
	return db.by_id('spaces', space_id)
		.then(function(space) {
			if(options.raw) return space;
			return space.data;
		});
};

/**
 * given a space id, pull out all user_ids accociated with the spaces.
 *
 * this is GREAT for generating sync records for boards/notes/invites
 */
exports.get_space_user_ids = function(space_id) {
	var qry = 'SELECT user_id FROM spaces_users WHERE space_id = {{space_id}}';
	return db.query(qry, {space_id: space_id})
		.then(function(res) {
			return res.map(function(rec) { return rec.user_id; });
		});
};

/**
 * get all spaces attached to a user
 */
exports.get_by_user_id = function(user_id, options) {
	options || (options = {});
	var role = options.role;
	var qry = [
		'SELECT',
		'	s.*',
		'FROM',
		'	spaces s,',
		'	spaces_users su',
		'WHERE',
		'	s.id = su.space_id AND',
		'	su.user_id = {{uid}}',
	];
	var params = {uid: user_id};
	if(role) {
		qry.push('	AND su.role = {{role}}');
		params.role = role;
	}
	return db.query(qry.join('\n'), params)
		.then(populate_members);
};

exports.create_space_user_record = function(space_id, user_id, role) {
	return db.insert('spaces_users', {space_id: space_id, user_id: user_id, role: role});
};

/**
 * get a space <--> user link record (which includes the space-user permissions)
 */
var get_space_user_record = function(user_id, space_id) {
	var qry = 'SELECT * FROM spaces_users WHERE space_id = {{space_id}} AND user_id = {{user_id}}';
	return db.first(qry, {space_id: space_id, user_id: user_id});
};

/**
 * get the data tree for a space (all the boards/notes/invites contained in it).
 */
exports.get_data_tree = function(space_id, options) {
	options || (options = {});
	var space_promise = get_by_id(space_id, {raw: true})
		.then(function(space) {
			return populate_members([space], options);
		})
		.then(function(spaces) {
			return spaces[0].data;
		});
	return Promise.all([
		space_promise,
		board_model.get_by_space_id(space_id),
		note_model.get_by_space_id(space_id),
	])
};

var add = function(user_id, data) {
	data.user_id = user_id;
	var data = vlad.validate('space', data);
	return db.insert('spaces', {id: data.id, data: data})
		.tap(function(space) {
			return exports.create_space_user_record(space.id, user_id, roles.owner);
		})
		.tap(function(space) {
			return sync_model.add_record([user_id], user_id, 'space', space.id, 'add')
				.then(function(sync_ids) {
					space.sync_ids = sync_ids;
				});
		});
};

var edit = function(user_id, data) {
	var space_id = data.id;
	var data = vlad.validate('space', data);
	return exports.permissions_check(user_id, space_id, permissions.edit_space)
		.then(function(_) {
			return get_by_id(space_id)
				.then(function(space_data) {
					// preserve user_id
					data.user_id = space_data.user_id;
					return db.update('spaces', space_id, {data: data});
				});
		})
		.tap(function(space) {
			return exports.get_space_user_ids(space_id)
				.then(function(user_ids) {
					return sync_model.add_record(user_ids, user_id, 'space', space_id, 'edit')
				})
				.then(function(sync_ids) {
					space.sync_ids = sync_ids;
				});
		});
};

var del = function(user_id, space_id) {
	var affected_users = null;
	return exports.permissions_check(user_id, space_id, permissions.delete_space)
		.tap(function() {
			return exports.get_space_user_ids(space_id)
				.then(function(user_ids) { affected_users = user_ids; });
		})
		.then(function(_) {
			return db.delete('spaces', space_id);
		})
		.then(function(_) {
			var params = {space_id: space_id};
			return Promise.all([
				db.query('DELETE FROM spaces_users WHERE space_id = {{space_id}}', params),
				db.query('DELETE FROM spaces_invites WHERE space_id = {{space_id}}', params),
				db.query('DELETE FROM notes WHERE space_id = {{space_id}}', params),
				db.query('DELETE FROM boards WHERE space_id = {{space_id}}', params),
			]);
		})
		.then(function(_) {
			return sync_model.add_record(affected_users, user_id, 'space', space_id, 'delete')
		});
};
exports.delete_space = del;

var link = function(ids) {
	return db.by_ids('spaces', ids, {fields: ['data']})
		.then(function(spaces) {
			return populate_members(spaces);
		})
		.then(function(items) {
			return items.map(function(i) { return i.data;});
		});
};

var set_owner = function(user_id, data) {
	var space_id = data.id;
	var new_user_id = data.user_id;
	return exports.permissions_check(user_id, space_id, permissions.set_space_owner)
		.then(function() {
			return get_by_id(space_id);
		})
		.then(function(space) {
			space.user_id = new_user_id;
			return db.update('spaces', space_id, {data: db.json(space)});
		});
};

/**
 * Abstracts adding a specific object type to a space. Handles validation,
 * inthertion uhhhuhuh, permissions checks, and creation of the corresponding
 * sync records.
 */
exports.simple_add = function(sync_type, sync_table, sync_permission, make_item_fn) {
	return function(user_id, data) {
		data.user_id = user_id;
		var data = vlad.validate(sync_type, data);
		var space_id = data.space_id;
		return exports.permissions_check(user_id, space_id, sync_permission)
			.then(function(_) {
				return db.insert(sync_table, make_item_fn(data));
			})
			.tap(function(item) {
				return exports.get_space_user_ids(space_id)
					.then(function(user_ids) {
						return sync_model.add_record(user_ids, user_id, sync_type, item.id, 'add');
					})
					.then(function(space_ids) {
						item.sync_ids = sync_ids;
					});
			});
	};
};

/**
 * Abstracts editing a specific object type in a space. Handles validation,
 * updating, permissions checks, and creation of the corresponding sync records.
 */
exports.simple_edit = function(sync_type, sync_table, sync_permission, get_by_id, make_item_fn) {
	return function(user_id, data) {
		var data = vlad.validate(sync_type, data);
		return get_by_id(data.id)
			.then(function(item_data) {
				// preserve user_id/space_id
				// And Charlie and I, we go down the sewer. And first thing we
				// do is to preserve our clothes, we take... take our clothes
				// off. We get totally naked because you don't want to get wet.
				// We ball our clothes up. We stick them up some place high.
				data.user_id = item_data.user_id;
				data.space_id = item_data.space_id;
				return exports.permissions_check(user_id, data.space_id, sync_permission)
			})
			.then(function(_) {
				return db.update(sync_table, data.id, make_item_fn(data));
			})
			.tap(function(item) {
				return exports.get_space_user_ids(data.space_id)
					.then(function(user_ids) {
						return sync_model.add_record(user_ids, user_id, sync_type, item.id, 'edit');
					})
					.then(function(sync_ids) {
						item.sync_ids = sync_ids;
					});
			});
	};
};

/**
 * Abstracts deleting a specific object type from a space. Handles permissions,
 * deletion, and sync record creation.
 */
exports.simple_delete = function(sync_type, sync_table, sync_permissions, get_by_id) {
	return function(user_id, item_id) {
		var space_id = null;
		return get_by_id(item_id)
			.then(function(item_data) {
				space_id = item_data.space_id;
				return exports.permissions_check(user_id, space_id, sync_permissions);
			})
			.then(function() {
				return db.delete(sync_table, item_id);
			})
			.then(function() {
				return exports.get_space_user_ids(space_id)
					.then(function(user_ids) {
						return symc_model.add_record(user_ids, user_id, sync_type, item_id, 'delete');
					});
			});
	};
};

sync_model.register('space', {
	'add': add,
	'edit': edit,
	'delete': del,
	'link': link,
	'set-owner': set_owner,
});
