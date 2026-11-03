#!/usr/bin/env node
import { inspectCryptoMaterial } from "./lib/crypto-material.mjs";

const args = new Set(process.argv.slice(2));
const requireMaterial = args.has("--require") || process.env.HEARTOPIA_RELEASE === "1";
const status = inspectCryptoMaterial(process.env.HEARTOPIA_CRYPTO_MATERIAL_B64);

if (status.valid) {
  console.log("crypto material: present, valid (48 bytes)");
  process.exit(0);
}

if (requireMaterial) {
  console.error(`crypto material: invalid (${status.reason})`);
  console.error("发布构建必须注入 HEARTOPIA_CRYPTO_MATERIAL_B64；值不会在此处显示。");
  process.exit(1);
}

console.log(`crypto material: absent (${status.reason}); public build keeps keyAvailable=false`);
