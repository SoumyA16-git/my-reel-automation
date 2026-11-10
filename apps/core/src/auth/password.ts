import argon2 from 'argon2';

// Argon2id parameters aligned with OWASP recommendations
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536,  // 64 MB
  timeCost: 3,         // 3 iterations
  parallelism: 1,
};

/**
 * Hash a password using Argon2id.
 * Returns the encoded string (includes algorithm, params, salt, and hash).
 */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

/**
 * Verify a password against an Argon2id encoded hash.
 * Returns true if the password matches, false otherwise.
 * Never throws on a bad password — only throws on internal errors.
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch (err) {
    // argon2.verify throws on malformed hashes; treat as "no match"
    if (err instanceof Error && err.message.includes('invalid')) {
      return false;
    }
    throw err;
  }
}

