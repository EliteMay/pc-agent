// Pure input validation for the opt-in OAuth smoke.
// Never log token strings or create an HTTP request here.
export function isSafeBearerToken(token) {
  return typeof token === "string" &&
    token.length >= 40 &&
    !/\s/u.test(token) &&
    !token.startsWith("Bearer ");
}
