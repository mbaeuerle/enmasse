/*
 * Copyright 2017-2018, EnMasse authors.
 * License: Apache License 2.0 (see the file LICENSE or http://apache.org/licenses/LICENSE-2.0.html).
 */
package enmasse.broker.prestop;

import enmasse.discovery.Endpoint;
import io.enmasse.amqp.Artemis;
import io.vertx.core.Vertx;
import io.vertx.proton.ProtonClientOptions;

import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeoutException;

public interface BrokerFactory {
    Artemis createClient(Vertx vertx, ProtonClientOptions clientOptions, Endpoint endpoint) throws InterruptedException, TimeoutException, ExecutionException;
}
