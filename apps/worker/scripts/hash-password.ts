import { hashPassword } from "../src/crypto.ts";

const password = process.argv[2];
if (!password) {
  console.error('usage: npm run hash-password -w @moli-insight/worker -- "your passphrase"');
  process.exit(2);
}
console.log(await hashPassword(password));
