/*
 * Copyright 2017 Red Hat Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

var assert = require('assert');
var events = require('events');
var util = require('util');
var rhea = require('rhea');
var myutils = require('../lib/utils.js');

var counters = {};

function next(name) {
    if (counters[name] === undefined) {
        counters[name] = 1;
    } else {
        ++counters[name];
    }
    return counters[name];
}

function generate_id(base) {
    return base + '-' + next(base);
}

function find(array, predicate) {
    var results = array.filter(predicate);
    if (results.length > 0) return results[0];
    else return undefined;
}

function match_source_address(link, address) {
    return link && link.local && link.local.attach && link.local.attach.source
        && link.local.attach.source.value[0].toString() === address;
}

var address_setting_names = [
    "DLA",
    "expiryAddress",
    "expiryDelay",
    "lastValueQueue",
    "deliveryAttempts",
    "maxSizeBytes",
    "pageSizeBytes",
    "pageMaxCacheSize",
    "redeliveryDelay",
    "redeliveryMultiplier",
    "maxRedeliveryDelay",
    "redistributionDelay",
    "sendToDLAOnNoRoute",
    "addressFullMessagePolicy",
    "slowConsumerThreshold",
    "slowConsumerCheckPeriod",
    "slowConsumerPolicy",
    "autoCreateJmsQueues",
    "autoDeleteJmsQueues",
    "autoCreateJmsTopics",
    "autoDeleteJmsTopics",
    "autoCreateQueues",
    "autoDeleteQueues",
    "autoCreateAddresses",
    "autoDeleteAddresses"
];

function get_address_settings (args) {
    var settings = {};
    for (var i = 0; i < args.length; i++) {
        settings[address_setting_names[i]] = args[i];
    }
    return settings;
}

function MockBroker (name) {
    this.name = name;
    this.objects = [];
    this.container = rhea.create_container({id:this.name});
    this.container.on('message', this.on_message.bind(this));
    var self = this;
    this.container.on('connection_open', function (context) {
        self.emit('connected', context);
    });
    this.container.on('connection_close', function (context) {
        self.emit('disconnected', context);
    });
    this.container.on('sender_open', function(context) {
        if (context.sender.source.dynamic) {
            var id = self.container.generate_uuid();
            context.sender.set_source({address:id});
        } else {
            context.sender.set_source({address:context.sender.remote.attach.source.address});
        }
    });

    var self = this;
    this.objects.push({
        resource_id: 'broker',
        getGlobalMaxSize : function () {
            return self.global_max_size;
        },
        getAddressNames : function () {
            return self.list_addresses().map(function (a) { return a.name; });
        },
        getQueueNames : function () {
            return self.list_queues().map(function (a) { return a.name; });
        },
        createQueue : function (address, routingType, name, filter, durable, maxConsumers, purgeOnNoConsumers, autoCreateAddress) {
            if (self.objects.some(function (o) { return o.type === 'queue' && o.name === name})) {
                throw new Error('queue ' + name + ' already exists!');
            } else {
                if (autoCreateAddress) {
                    if (!self.objects.some(function (o) { return o.type === 'address' && o.name === address; })) {
                        self.add_address(address, false, 0, [name]);
                    }
                } else {
                    if (!self.objects.some(function (o) { return o.type === 'address' && o.name === address; })) {
                        throw new Error('No such address ' + address + ' for queue ' + name);
                    }
                }
                self.add_queue(name, {'durable':durable, 'routingType':routingType, 'maxConsumers':maxConsumers, 'address':address, 'filter':filter, 'purgeOnNoConsumers':purgeOnNoConsumers});
            }
        },
        createAddress : function (name, routingTypes) {
            if (self.objects.some(function (o) { return o.type === 'address' && o.name === name; })) {
                throw new Error('address ' + name + ' already exists!');
            } else {
                self.add_address(name, true);
            }
        },
        destroyQueue : function (name) {
            if (myutils.remove(self.objects, function (o) { return o.type === 'queue' && o.name === name; }) !== 1) {
                throw new Error('error deleting queue ' + name);
            } else {
                function is_queue_address(o) {
                    return o.type === 'address' && o.name === name
                        && o.routingTypesAsJSON[0] === 'ANYCAST'
                        && o.queueNames.length === 1
                        && o.queueNames[0] === name;
                }
                myutils.remove(self.objects, is_queue_address);
            }
        },
        deleteAddress : function (name) {
            if (myutils.remove(self.objects, function (o) { return o.type === 'address' && o.name === name; }) !== 1) {
                throw new Error('error deleting address ' + name);
            }
        },
        addAddressSettings : function () {
            if (self.objects.some(function (o) { return o.type === 'address_settings' && o.match === arguments[0]; })) {
                throw new Error('address settings for ' + o.match + ' already exists!');
            } else {
                self.add_address_settings(arguments[0], get_address_settings(Array.prototype.slice.call(arguments, 1)));
            }
        },
        removeAddressSettings : function (match) {
            if (myutils.remove(self.objects, function (o) { return o.type === 'address_settings' && o.match === match; }) !== 1) {
                throw new Error('error deleting address settings ' + match);
            }
        },
        listAddresses : function () {
            var items = self.get('address');
            return JSON.stringify({data:items, count:items.length});
        },
        listQueues : function () {
            var items = self.get('queue');
            return JSON.stringify({data:items, count:items.length});
        },
        listConnectionsAsJSON : function () {
            return JSON.stringify(self.get('connection'));
        },
        listSessionsAsJSON : function (connectionID) {
            return JSON.stringify(self.get('session').filter(function (s) { return s.connectionID === connectionID; }));
        },
        listProducersInfoAsJSON  : function () {
            return JSON.stringify(self.get('producer'));
        },
        listAllConsumersAsJSON : function () {
            return JSON.stringify(self.get('consumer'));
        },
        createConnectorService : function (name, ignore, params) {
            if (self.objects.some(function (o) { return o.type === 'connector' && o.name === name; })) {
                throw new Error('connector for ' + name + ' already exists!');
            } else {
                self.add_connector(name, {name: name, source: params.sourceAddress, target: params.clientAddress});
            }
        },
        destroyConnectorService : function (name) {
            if (myutils.remove(self.objects, function (o) { return o.type === 'connector' && o.name === name; }) !== 1) {
                throw new Error('error deleting connector ' + name);
            }
        },
        getConnectorServices : function () {
            return self.get('connector').map(function (c) { return c.name; });
        }
    });
}

util.inherits(MockBroker, events.EventEmitter);

MockBroker.prototype.listen = function (port) {
    this.server = this.container.listen({port:port || 0});
    var self = this;
    this.server.on('listening', function () {
        self.port = self.server.address().port;
    });
    return this.server;
};

MockBroker.prototype.connect = function (port) {
    return this.container.connect({port:port, properties:{product:'apache-activemq-artemis'}});
};

MockBroker.prototype.close = function (callback) {
    if (this.server) this.server.close(callback);
};

MockBroker.prototype.on_message = function (context) {
    var request = context.message;
    var resource = context.message.application_properties._AMQ_ResourceName;
    var operation = context.message.application_properties._AMQ_OperationName;
    var params = request.body ? JSON.parse(request.body) : [];
    var target = find(this.objects, function (o) { return o.resource_id === resource; });
    var reply_link = context.connection.find_sender(function (s) { return match_source_address(s, request.reply_to); });
    try {
        if (target) {
            if (target[operation]) {
                var result = target[operation].apply(target, params);
                //console.log('invocation of ' + operation + ' on ' + resource + ' returned ' + JSON.stringify(result));
                if (reply_link) {
                    reply_link.send({application_properties:{_AMQ_OperationSucceeded:true}, body:JSON.stringify([result])});
                }
            } else {
                throw new Error('no such operation: ' + operation + ' on' + resource);
            }
        } else {
            throw new Error('no such resource: ' + resource);
        }
    } catch (e) {
        console.log('invocation of ' + operation + ' on ' + resource + ' failed: ' + e);
        if (reply_link) {
            reply_link.send({application_properties:{_AMQ_OperationSucceeded:false}, body:util.format('%s', e)});
        }
    }
};

var prefixes = {
    'is': false,
    'get': 0
};

function Resource (name, type, accessors, properties) {
    this.name = name;
    this.type = type;
    this.resource_id = type + '.' + name;
    var initial_values = properties || {};
    if (accessors === undefined) {
        for (var key in properties) {
            this[key] = properties[key];
        }
    } else {
        var self = this;
        accessors.forEach(function (accessor) {
            for (var prefix in prefixes) {
                if (accessor.indexOf(prefix) === 0) {
                    var property = accessor.charAt(prefix.length).toLowerCase() + accessor.substr(prefix.length + 1);
                    self[property] = initial_values[property] || prefixes[prefix];
                    self[accessor] = function () { return self[property]; };
                }
            }
        });
    }
}

function add_id(object, type, id_name) {
    var field = id_name || type + 'ID';
    if (object[field] === undefined) {
        object[field] = generate_id(type);
    }
    return object[field];
}

MockBroker.prototype.add_resource_with_id = function (type, properties) {
    var id = add_id(properties, type);
    this.objects.push(new Resource(id, type, undefined, properties));
    return id;
};

MockBroker.prototype.add_connection_child_resource = function (type, connectionID, objects) {
    if (objects !== undefined) {
        var self = this;
        objects.forEach(function (o) {
            o.connectionID = connectionID;
            self.add_resource_with_id(type, o)
        });
    }
};

MockBroker.prototype.add_connection = function (properties, senders, receivers, sessions) {
    var connectionID = this.add_resource_with_id('connection', properties);
    this.add_connection_child_resource('producer', connectionID, senders);
    this.add_connection_child_resource('consumer', connectionID, receivers);
    this.add_connection_child_resource('session', connectionID, sessions);
};

var queue_accessors = ['isTemporary', 'isDurable', 'getMessageCount', 'getConsumerCount', 'getMessagesAdded',
                       'getDeliveringCount', 'getMessagesAcked', 'getMessagesExpired', 'getMessagesKilled',
                       'getAddress', 'getRoutingType'];
var address_accessors = ['getRoutingTypesAsJSON','getRoutingTypes','getNumberOfMessages','getQueueNames', 'getMessageCount'];

MockBroker.prototype.add_queue = function (name, properties) {
    var queue = new Resource(name, 'queue', queue_accessors, properties);
    this.objects.push(queue);
    return queue;
};

MockBroker.prototype.add_address = function (name, is_multicast, messages, queue_names) {
    var address = new Resource(name, 'address', address_accessors, {
        queueNames: queue_names || [],
        numberOfMessages: messages || 0,
        routingTypesAsJSON: [is_multicast ? 'MULTICAST' : 'ANYCAST'],
        routingTypes: [is_multicast ? 'MULTICAST' : 'ANYCAST'],
        messageCount: messages || 0
    });
    this.objects.push(address);
    return address;
};

MockBroker.prototype.add_address_settings = function (name, settings) {
    var o = new Resource(name, 'address_settings', undefined, settings);
    this.objects.push(o);
    return o;
};

MockBroker.prototype.add_queue_address = function (name, properties) {
    this.add_queue(name, myutils.merge({address: name, routingType:'ANYCAST'}, properties));
    var addr = this.add_address(name, false, 0, [name]);
    return addr;
};

MockBroker.prototype.add_topic_address = function (name, subscribers, messages) {
    for (var s in subscribers) {
        this.add_queue(s, myutils.merge({address: name, routingType:'MULTICAST'}, subscribers[s]));
    }
    return this.add_address(name, true, messages, Object.keys(subscribers));
};

MockBroker.prototype.add_connector = function (name, connector) {
    var o = new Resource(name, 'connector', undefined, connector);
    this.objects.push(o);
    return o;
};

MockBroker.prototype.get = function (type) {
    return this.objects.filter(function (o) { return o.type === type; });
};

MockBroker.prototype.list_queues = function () {
    return this.get('queue');
};

MockBroker.prototype.list_addresses = function () {
    return this.get('address');
};

MockBroker.prototype.list_address_settings = function () {
    return this.get('address_settings');
};


MockBroker.prototype.get_pod_descriptor = function () {
    return {
        ready : (this.port === undefined ? 'False' : 'True'),
        phase : 'Running',
        name : this.name,
        host : 'localhost',
        ports : {
            broker : {
                amqp: this.port
            }
        }
    };
};


MockBroker.prototype.get_pod_definition = function () {
    return {
        metadata: {
            name: this.name,
            labels: {
                role: 'broker'
            }
        },
        spec: {
            containers: [
                {
                    name: 'broker',
                    ports: [
                        {
                            name: 'amqp',
                            containerPort: this.port
                        }
                    ]
                }
            ]
        },
        status: {
            podIP: '127.0.0.1',
            phase: 'Running',
            conditions : [
                { type: 'Initialized', status: 'True' },
                { type: 'Ready', status: (this.port === undefined ? 'False' : 'True') }
            ]
        }
    };
};

function remove(list, predicate) {
    var removed = [];
    for (var i = 0; i < list.length; ) {
        if (predicate(list[i])) {
            removed.push(list.splice(i, 1)[0]);
        } else {
            i++;
        }
    }
    return removed;
}

MockBroker.prototype.verify_queue = function (addresses, queues, name) {
    var results = remove(queues, function (o) { return o.name === name; });
    assert.equal(results.length, 1, util.format('queue %s not found', name));
    assert.equal(results[0].name, name);
    results = remove(addresses, function (o) { return o.name === name; });
    assert.equal(results.length, 1, util.format('address %s not found', name));
    assert.equal(results[0].name, name);
    assert.equal(results[0].routingTypesAsJSON[0], 'ANYCAST');
    assert.equal(results[0].queueNames[0], name);
    return results[0];
};

MockBroker.prototype.verify_topic = function (addresses, name) {
    var results = remove(addresses, function (o) { return o.name === name; });
    assert.equal(results.length, 1, util.format('address %s not found', name));
    assert.equal(results[0].name, name);
    assert.equal(results[0].routingTypesAsJSON[0], 'MULTICAST');
    return results[0];
};

MockBroker.prototype.verify_subscription = function (queues, name, topic) {
    var results = remove(queues, function (o) { return o.name === name; });
    assert.equal(results.length, 1, util.format('subscription queue %s not found', name));
    assert.equal(results[0].name, name);
    assert.equal(results[0].address, topic);
    return results[0];
};

MockBroker.prototype.verify_addresses = function (expected) {
    var addresses = this.list_addresses();
    var queues = this.list_queues();
    for (var i = 0; i < expected.length; i++) {
        if (expected[i].type === 'queue') {
            this.verify_queue(addresses, queues, expected[i].address);
        } else if (expected[i].type === 'topic') {
            this.verify_topic(addresses, expected[i].address);
        } else if (expected[i].type === 'subscription') {
            this.verify_subscription(queues, expected[i].address, expected[i].topic);
        }
    }
    assert.equal(addresses.length, 0);
    assert.equal(queues.length, 0);
};

MockBroker.prototype.verify_address_settings = function (expected) {
    var settings = this.list_address_settings();
    for (var i = 0; i < expected.length; i++) {
        var s = remove(settings, function (o) { return o.name === expected[i].match; })[0];
        assert(s, util.format('no settings object found for %s', expected[i].match));
        for (var f in expected[i]) {
            if (f !== 'match') {
                assert.equal(s[f], expected[i][f], util.format('address setting %s does not match got %s expected %s', f, s[f], expected[i][f]));
            }
        }
    }
    assert.equal(settings.length, 0, util.format('extra settings found: %j', settings));
};

MockBroker.prototype.verify_connectors = function (expected) {
    var connectors = this.get('connector');
    for (var i = 0; i < expected.length; i++) {
        var s = remove(connectors, function (o) { return o.name === expected[i].name; })[0];
        assert(s, util.format('no connector object found for %s', expected[i].name));
        for (var f in expected[i]) {
            assert.equal(s[f], expected[i][f], util.format('connector %s does not match got %s expected %s', f, s[f], expected[i][f]));
        }
    }
    assert.equal(connectors.length, 0, util.format('extra connectors found: %j', connectors));
};

module.exports = MockBroker;
