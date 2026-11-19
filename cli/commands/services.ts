import { resolve } from "node:path";
import type { Args } from "../args.ts";
import { oidcVerifier } from "../../src/services/oidc.ts";
import { createServiceHandler, fileStore } from "../../src/services/server.ts";

/**
 * Run the reference player service: guest sign-in and cloud saves out of the box, Apple and
 * Google accounts when their audiences are given. Data lives in one JSON file.
 */
export async function services(args: Args): Promise<void> {
  const port = args.num("port", 4250);
  const data = resolve(args.str("data", "blackiron-services.json"));
  const apple = args.flags["apple-audience"];
  const google = args.flags["google-audience"];
  if (apple === true || google === true) throw new Error("--apple-audience and --google-audience require a value");
  const list = (v: string): string[] => v.split(",").map((s) => s.trim()).filter(Boolean);
  const verify =
    apple || google
      ? oidcVerifier({
          ...(typeof apple === "string" ? { apple: { audience: list(apple) } } : {}),
          ...(typeof google === "string" ? { google: { audience: list(google) } } : {}),
        })
      : undefined;
  const handler = createServiceHandler({ store: await fileStore(data), verify });
  const server = Bun.serve({ port, fetch: handler });
  console.log(`Blackiron player service on http://localhost:${server.port}`);
  console.log(`  data: ${data}`);
  console.log(`  accounts: guest${apple ? ", apple" : ""}${google ? ", google" : ""}`);
  console.log(`  blackiron.json: "services": { "provider": "http", "url": "http://localhost:${server.port}" }`);
  await new Promise(() => {});
}
