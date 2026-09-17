// Cifrado de credenciales de TPV (AES-256-GCM). La clave se lee SOLO al
// cifrar/descifrar, nunca al arrancar el servidor — hoy no hay ningún
// cliente con TPV conectado, así que POS_CREDENTIALS_KEY no tiene por qué
// existir todavía en Railway (y no forma parte de los REQUIRED de index.js).
const crypto = require('crypto');

function getKey() {
  const raw = process.env.POS_CREDENTIALS_KEY;
  if (!raw) throw new Error('POS_CREDENTIALS_KEY no está configurada');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('POS_CREDENTIALS_KEY debe decodificar a 32 bytes (AES-256) en base64');
  return key;
}

// Devuelve { iv, tag, data } en base64 — encaja en una columna jsonb tal cual.
function cifrarCredenciales(objeto) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(objeto), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('base64'), tag: tag.toString('base64'), data: data.toString('base64') };
}

function descifrarCredenciales(cifrado) {
  const key = getKey();
  const iv = Buffer.from(cifrado.iv, 'base64');
  const tag = Buffer.from(cifrado.tag, 'base64');
  const data = Buffer.from(cifrado.data, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

module.exports = { cifrarCredenciales, descifrarCredenciales };
