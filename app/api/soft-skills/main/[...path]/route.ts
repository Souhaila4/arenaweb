// Server-side proxy: HTTPS frontend → Python "main" soft-skills service.
// Same pattern as ../frame/[...path]/route.ts but for the port-5000 service.

const TARGET =
  process.env.SOFT_SKILLS_API_URL ||
  process.env.NEXT_PUBLIC_SOFT_SKILLS_API_URL ||
  "http://localhost:5000";

function buildUrl(path: string[], search: string): string {
  return `${TARGET.replace(/\/+$/, "")}/${path.join("/")}${search}`;
}

async function proxy(req: Request, path: string[]): Promise<Response> {
  const search = new URL(req.url).search;
  const url = buildUrl(path, search);

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (k === "host" || k === "connection" || k === "content-length") return;
    headers.set(key, value);
  });

  let body: ArrayBuffer | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    try {
      body = await req.arrayBuffer();
    } catch { /* no body */ }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const res = await fetch(url, {
      method: req.method,
      headers,
      body: body?.byteLength ? body : undefined,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const buf = await res.arrayBuffer();
    return new Response(buf, {
      status: res.status,
      statusText: res.statusText,
      headers: {
        "Content-Type": res.headers.get("Content-Type") ?? "application/octet-stream",
      },
    });
  } catch (err) {
    clearTimeout(timeout);
    const msg = err instanceof Error ? err.message : String(err);
    const hint = msg.includes("ECONNREFUSED")
      ? "Service Python soft-skills (main) injoignable. Démarre-le sur " + TARGET + "."
      : `Proxy soft-skills main failed: ${msg}`;
    return Response.json({ message: hint }, { status: 502 });
  }
}

export async function GET(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await params).path);
}
export async function POST(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await params).path);
}
export async function PUT(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await params).path);
}
export async function PATCH(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await params).path);
}
export async function DELETE(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await params).path);
}
