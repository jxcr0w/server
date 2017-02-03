"use strict";

var model = require('../models/invite');
var tres = require('../helpers/tres');

exports.route = function(app) {
	app.post('/spaces/:space_id/invites', send_invite);
	app.put('/spaces/:space_id/invites/:invite_id', update_invite);
	app.post('/spaces/:space_id/invites/accepted/:invite_id', accept_invite);
	app.delete('/spaces/:space_id/invites/:invite_id', delete_invite);
};

var send_invite = function(req, res) {
	var from_user_id = req.user.id;
	var data = req.body;
	var to_user = data.to_user;
	var space_id = req.params.space_id;
	tres.wrap(res, model.send(from_user_id, to_user, space_id, data));
};

var update_invite = function(req, res) {
	var user_id = req.user.id;
	var space_id = req.params.space_id;
	var invite_id = req.params.invite_id;
	var data = req.body;
	tres.wrap(res, model.update(user_id, space_id, invite_id, data));
};

var accept_invite = function(req, res) {
	var user_id = req.user.id;
	var space_id = req.params.space_id;
	var invite_id = req.params.invite_id;
	tres.wrap(res, model.accept(user_id, space_id, invite_id));
};

var delete_invite = function(req, res) {
	var user_id = req.user.id;
	var space_id = req.params.space_id;
	var invite_id = req.params.invite_id;
	tres.wrap(res, model.delete(user_id, space_id, invite_id));
};
