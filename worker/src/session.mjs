const SESSION_SECRETS = ['DEVICE_TOKEN', 'ELEVENLABS_API_KEY', 'ELEVEN_AGENT_ID'];

export function missingSessionSecrets(env) {
  return SESSION_SECRETS.filter((name) => typeof env[name] !== 'string' || !env[name].trim());
}

export function parseDailyCap(raw, fallback = 20) {
  const cap = raw === undefined || raw === null || raw === '' ? fallback : Number(raw);
  return Number.isSafeInteger(cap) && cap > 0 ? cap : null;
}
