/*
 * Copyright 2017-2018, EnMasse authors.
 * License: Apache License 2.0 (see the file LICENSE or http://apache.org/licenses/LICENSE-2.0.html).
 */
package io.enmasse.keycloak.controller;

import io.enmasse.user.keycloak.KeycloakFactory;
import org.keycloak.admin.client.resource.IdentityProviderResource;
import org.keycloak.admin.client.resource.IdentityProvidersResource;
import org.keycloak.admin.client.resource.RealmResource;
import org.keycloak.representations.idm.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

public class Keycloak implements KeycloakApi {

    private static final Logger log = LoggerFactory.getLogger(Keycloak.class);

    private static final String OPENSHIFT_PROVIDER_ALIAS = "openshift-v3";
    private static final String IDENTITY_PROVIDER_CLIENT_SECRET = "clientSecret";
    private static final String IDENTITY_PROVIDER_CLIENT_ID = "clientId";
    private static final String IDENTITY_PROVIDER_BASE_URL = "baseUrl";

    private final KeycloakFactory keycloakFactory;
    private final Map<String, IdentityProviderParams> realmState = new ConcurrentHashMap<>();
    private volatile org.keycloak.admin.client.Keycloak keycloak;

    public Keycloak(KeycloakFactory keycloakFactory) {
        this.keycloakFactory = keycloakFactory;
    }

    interface Handler<T> {
        T handle(org.keycloak.admin.client.Keycloak keycloak);
    }

    private synchronized <T> T withKeycloak(Handler<T> consumer) {
        if (keycloak == null) {
            keycloak = keycloakFactory.createInstance();
        }
        return consumer.handle(keycloak);
    }

    @Override
    public Set<String> getRealmNames() {
        return withKeycloak(kc -> kc.realms().findAll().stream()
                .map(RealmRepresentation::getRealm)
                .collect(Collectors.toSet()));
    }

    @Override
    public void createRealm(String namespace, String realmName, String consoleRedirectURI, IdentityProviderParams params) {
        final RealmRepresentation newRealm = new RealmRepresentation();
        newRealm.setRealm(realmName);
        newRealm.setEnabled(true);
        newRealm.setPasswordPolicy("hashAlgorithm(scramsha1)");
        newRealm.setAttributes(new HashMap<>());
        newRealm.getAttributes().put("namespace", namespace);
        newRealm.getAttributes().put("enmasse-realm", "true");

        if (params.getIdentityProviderUrl() != null && params.getIdentityProviderClientId() != null && params.getIdentityProviderClientSecret() != null) {
            IdentityProviderRepresentation openshiftIdProvider = new IdentityProviderRepresentation();

            Map<String, String> config = new HashMap<>();

            config.put(IDENTITY_PROVIDER_BASE_URL, params.getIdentityProviderUrl());
            config.put(IDENTITY_PROVIDER_CLIENT_ID, params.getIdentityProviderClientId());
            config.put(IDENTITY_PROVIDER_CLIENT_SECRET, params.getIdentityProviderClientSecret());

            openshiftIdProvider.setConfig(config);
            openshiftIdProvider.setEnabled(true);
            openshiftIdProvider.setProviderId("openshift-v3");
            openshiftIdProvider.setAlias(OPENSHIFT_PROVIDER_ALIAS);
            openshiftIdProvider.setDisplayName("OpenShift");
            openshiftIdProvider.setTrustEmail(true);
            openshiftIdProvider.setFirstBrokerLoginFlowAlias("direct grant");

            newRealm.addIdentityProvider(openshiftIdProvider);
        }

        if (consoleRedirectURI != null) {
            final ClientRepresentation console = new ClientRepresentation();
            console.setClientId("enmasse-console");
            console.setPublicClient(true);
            console.setRedirectUris(Collections.singletonList(consoleRedirectURI));
            newRealm.setClients(Collections.singletonList(console));
        }

        withKeycloak(kc -> {
            kc.realms().create(newRealm);
            realmState.put(realmName, params);
            return true;
        });
    }

    @Override
    public void updateRealm(String realmName, IdentityProviderParams updated) {
        IdentityProviderParams current = realmState.getOrDefault(realmName, IdentityProviderParams.NULL_PARAMS);
        if (!updated.equals(current)) {
            withKeycloak(kc -> {
                RealmResource realm = kc.realm(realmName);
                if (realm != null) {

                    IdentityProvidersResource identityProvidersResource = realm.identityProviders();
                    IdentityProviderResource identityProviderResource = identityProvidersResource.get(OPENSHIFT_PROVIDER_ALIAS);
                    if (identityProviderResource != null) {
                        IdentityProviderRepresentation identityProviderRepresentation = identityProviderResource.toRepresentation();
                        Map<String, String> newConfig = new HashMap<>(identityProviderRepresentation.getConfig());
                        Set<String> updatedItems = new HashSet<>();

                        String updatedBaseUrl = updated.getIdentityProviderUrl();
                        if (!Objects.equals(updatedBaseUrl, current.getIdentityProviderUrl())) {
                            newConfig.put(IDENTITY_PROVIDER_BASE_URL, updatedBaseUrl);
                            updatedItems.add(IDENTITY_PROVIDER_BASE_URL);
                        }

                        String updatedClientId = updated.getIdentityProviderClientId();
                        if (!Objects.equals(updatedClientId, current.getIdentityProviderClientId())) {
                            newConfig.put(IDENTITY_PROVIDER_CLIENT_ID, updatedClientId);
                            updatedItems.add(IDENTITY_PROVIDER_CLIENT_ID);
                        }

                        String updatedSecret = updated.getIdentityProviderClientSecret();
                        if (!Objects.equals(updatedSecret, current.getIdentityProviderClientSecret())) {
                            newConfig.put(IDENTITY_PROVIDER_CLIENT_SECRET, updatedSecret);
                            updatedItems.add(IDENTITY_PROVIDER_CLIENT_SECRET);
                        }

                        if (!updatedItems.isEmpty()) {
                            identityProviderRepresentation.setConfig(newConfig);
                            identityProviderResource.update(identityProviderRepresentation);
                            log.info("Updated identity provider alias {}. Parameters updated: {}",
                                    OPENSHIFT_PROVIDER_ALIAS, updatedItems);
                            realmState.put(realmName, updated);
                        }
                    } else {
                        log.info("Could not find identity provider with alias {}", OPENSHIFT_PROVIDER_ALIAS);
                    }
                }
                return true;
            });

        }

    }

    @Override
    public void deleteRealm(String realmName) {
        withKeycloak(kc -> {

            try {
                kc.realm(realmName).remove();
            } finally {
                realmState.remove(realmName);
            }

            return true;
        });
    }
}
