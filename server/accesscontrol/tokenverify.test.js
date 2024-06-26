import { describe, test } from 'node:test';
import { isTokenValidForAccount, TOKEN_EXPIRY_MILLIS } from './tokenverify.js';
import { equal } from 'node:assert/strict';

describe.only('verify tokens', () => {
    test.only('valid token', () => {
        equal(isTokenValidForAccount('peter.near', { 'accountId': 'peter.near', iat: new Date().getTime() }), true);
    });

    test.only('token issued too far in the future', () => {
        equal(isTokenValidForAccount('peter.near', { 'accountId': 'peter.near', iat: new Date().getTime() + TOKEN_EXPIRY_MILLIS }), false);
    });

    test.only('token is expired', () => {
        equal(isTokenValidForAccount('peter.near', { 'accountId': 'peter.near', iat: new Date().getTime() - TOKEN_EXPIRY_MILLIS }), false);
    });

    test.only('token is near expiry', () => {
        equal(isTokenValidForAccount('peter.near', { 'accountId': 'peter.near', iat: new Date().getTime() - (TOKEN_EXPIRY_MILLIS + 10) }), false);
    });

    test.only('token for other account', () => {
        equal(isTokenValidForAccount('johan.near', { 'accountId': 'peter.near', iat: new Date().getTime() }), false);
    });


});
