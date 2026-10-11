import { registerHooks } from "node:module";

/** Bare `zing` is this station, not a package the plugin directory happens to see. */
const ZING_SPECIFIER = "zing";
const ZING_API_URL = new URL("./api.ts", import.meta.url).href;

let installed = false;

export function installZingSpecifier(): void {
  if (installed) {
    return;
  }
  installed = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === ZING_SPECIFIER) {
        return nextResolve(ZING_API_URL, context);
      }
      return nextResolve(specifier, context);
    },
  });
}
