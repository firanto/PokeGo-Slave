var NotificationHelper = function () {
	this.clients = [];
	
	/**
	 * add client by client id and socket
	 */
	this.addClient = function (clientId, socket) {
		this.clients[clientId] = socket;
	};
	
	/**
	 * remove client by client id
	 */
	this.removeClient = function (clientId) {
		delete this.clients[clientId];
	};
	
	/**
	* send notification to user id.
	* notification type is string in dashed lower case format i.e 'hello-world'.
	* data is any javascript object which will be sent to client
	*/ 
	this.sendNotification = function (clientId, notificationType, data) {
		var socket = this.clients[clientId];
		if (socket)
			socket.emit('notification', { type: notificationType, data: data });
	}
};

module.exports = new NotificationHelper();