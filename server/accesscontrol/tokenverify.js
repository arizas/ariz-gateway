export const TOKEN_EXPIRY_MILLIS = 5 * 60 * 1000;

export function isTokenValidForAccount(accountId, tokenPayload) {
    return accountId == tokenPayload.accountId && tokenPayload.iat <= new Date().getTime() &&
        tokenPayload.iat > (new Date().getTime() - TOKEN_EXPIRY_MILLIS)
}