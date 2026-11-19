import type { Net } from "../net/types.ts";
import { NetError, type Timers } from "../net/types.ts";
import type { StoreBackend } from "../save/store.ts";
import { CloudSaves, type CloudOptions } from "./cloud.ts";
import { Identity } from "./identity.ts";
import { AptevaProvider } from "./providers/apteva.ts";
import { HttpProvider } from "./providers/http.ts";
import { MockProvider } from "./providers/mock.ts";
import { ServiceError, type PlatformSignIn, type ServiceProvider, type ServicesConfig } from "./types.ts";

export * from "./types.ts";
export { Identity, HostSignIn, type IdentityOptions } from "./identity.ts";
export { CloudSaves, type CloudOptions, type CloudStatus, type ConflictPolicy, type SyncReport } from "./cloud.ts";
export { MockProvider } from "./providers/mock.ts";
export { HttpProvider, serviceRequest } from "./providers/http.ts";
export { AptevaProvider, aptevaKey, fromAptevaKey, type AptevaOptions } from "./providers/apteva.ts";

export type ProviderFactory = (config: ServicesConfig, net: Net) => ServiceProvider;

const needUrl = (config: ServicesConfig): string => {
  if (!config.url) throw new ServiceError("rejected", `services.url is required for the "${config.provider}" provider`);
  return config.url;
};

const registry = new Map<string, ProviderFactory>([
  ["mock", () => new MockProvider()],
  ["http", (config, net) => new HttpProvider(net, needUrl(config))],
  ["apteva", (config, net) => new AptevaProvider(net, { url: needUrl(config), game: config.game ?? "", project: config.project })],
]);

/**
 * Plug in a backend of your own: implement ServiceProvider and register it under the name
 * `blackiron.json` uses in `services.provider`. Register before `App.create`.
 */
export function registerProvider(name: string, factory: ProviderFactory): void {
  registry.set(name, factory);
}

export function providerNames(): string[] {
  return [...registry.keys()];
}

/** A Net for hosts built without networking: every request fails as unsupported. */
const noNet: Net = {
  connect() {
    throw new NetError("This host has no networking", "unsupported");
  },
  request(req) {
    return Promise.reject(new NetError(`This host has no networking: ${req.url}`, "unsupported"));
  },
};

export function createProvider(config: ServicesConfig, net?: Net): ServiceProvider {
  const factory = registry.get(config.provider);
  if (!factory) throw new ServiceError("rejected", `Unknown services.provider "${config.provider}". Known: ${providerNames().join(", ")}. Register others with registerProvider().`);
  return factory(config, net ?? noNet);
}

export interface Services {
  readonly provider: ServiceProvider;
  readonly identity: Identity;
  /** Cloud saves, when the game turned them on (`cloud: true`). */
  readonly saves: CloudSaves | null;
}

export interface ServicesOptions {
  config: ServicesConfig;
  net?: Net;
  /** The device's storage: holds the session and the local copy of every save. */
  storage: StoreBackend;
  platformSignIn?: PlatformSignIn;
  /** Turn on cloud saves, with options for which keys sync and how conflicts settle. */
  cloud?: boolean | Pick<CloudOptions, "keys" | "conflict" | "debounceMs">;
  timers?: Timers;
  now?: () => number;
}

export function createServices(opts: ServicesOptions): Services {
  const provider = createProvider(opts.config, opts.net);
  const identity = new Identity({ provider, storage: opts.storage, platform: opts.platformSignIn, now: opts.now });
  const saves = opts.cloud
    ? new CloudSaves({ identity, local: opts.storage, timers: opts.timers ?? opts.net?.timers, now: opts.now, ...(typeof opts.cloud === "object" ? opts.cloud : {}) })
    : null;
  return { provider, identity, saves };
}
