const { OAuth2Client } = require("google-auth-library");

class AuthError extends Error {}

let client = null;
function getClient() {
  if (!client) {
    if (!process.env.GOOGLE_OAUTH_CLIENT_ID) {
      throw new Error("Missing GOOGLE_OAUTH_CLIENT_ID env var");
    }
    client = new OAuth2Client(process.env.GOOGLE_OAUTH_CLIENT_ID);
  }
  return client;
}

/**
 * Verifies the Google Sign-In ID token sent by the frontend in the
 * Authorization header ("Bearer <token>"), and checks the signed-in
 * account belongs to the practice's Workspace domain.
 *
 * Returns { email, name } for the verified doctor — this is what the
 * backend trusts for "who did this," NOT any name typed in the UI.
 */
async function verifyRequest(event) {
  const header = event.headers.authorization || event.headers.Authorization;
  if (!header || !header.startsWith("Bearer ")) {
    throw new AuthError("Missing bearer token — sign in with Google first");
  }
  const idToken = header.slice(7);

  const ticket = await getClient().verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_OAUTH_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  const email = payload.email;
  const domain = payload.hd || (email || "").split("@")[1];
  const allowedDomain = process.env.ALLOWED_DOMAIN || "thegajerpractice.com";

  if (!payload.email_verified) throw new AuthError("Email not verified with Google");
  if (domain !== allowedDomain) throw new AuthError(`Account domain "${domain}" is not authorized`);

  return { email, name: payload.name || email };
}

module.exports = { verifyRequest, AuthError };
