import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const output = path.join(root, "appsail-build");
const requiredPaths = [
  "dist",
  "server",
  "catalyst-server.mjs",
  "package.json",
  "package-lock.json",
];

if (!fs.existsSync(path.join(root, "dist", "index.html"))) {
  throw new Error("Production build is missing. Run npm run build first.");
}

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

for (const relativePath of requiredPaths) {
  fs.cpSync(path.join(root, relativePath), path.join(output, relativePath), {
    recursive: true,
  });
}

console.log("Prepared AppSail build in appsail-build.");
