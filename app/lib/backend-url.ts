/**
 * Origine du backend NestJS (sans slash final).
 *
 * - Navigateur : préfixe relatif `/api` → relayé par `app/api/[...path]/route.ts` vers le Nest
 *   (évite CORS et garde une seule config côté client).
 * - Serveur (RSC, route handlers, etc.) : URL absolue vers le Nest.
 *
 * Variables :
 * - `NEXT_PUBLIC_API_URL` — URL du backend (ex. http://10.16.146.142:3000), lue partout
 * - `API_URL` — optionnel, prioritaire côté serveur uniquement (ex. http://backend:3000 en Docker)
 */
const DEFAULT_BACKEND_ORIGIN = "http://10.16.146.142:3000";

export function getBackendOrigin(): string {
  if (typeof process === "undefined" || !process.env) {
    return DEFAULT_BACKEND_ORIGIN;
  }
  const raw = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || DEFAULT_BACKEND_ORIGIN;
  return String(raw).replace(/\/+$/, "");
}

/** Base utilisée par `fetch` : relatif `/api` dans le navigateur, origine directe sur le serveur. */
export function getFetchBaseUrl(): string {
  if (typeof window !== "undefined") {
    return "/api";
  }
  return getBackendOrigin();
}
