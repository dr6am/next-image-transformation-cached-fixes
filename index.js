const version = "0.0.4";

let allowedDomains = (process?.env?.ALLOWED_REMOTE_DOMAINS ?? "*")
    .split(",")
    .map((d) => d.trim().toLowerCase());

let imgproxyUrl = process?.env?.IMGPROXY_URL || "http://imgproxy:8080";
if (process.env.NODE_ENV === "development") imgproxyUrl = "http://localhost:8888";

const cacheInvalidationTime =
    Number(process?.env?.CACHE_INVALIDATION_TIME) || 24 * 60 * 60; // сек.

function domainAllowed(origin) {
    return allowedDomains.some((domain) => {
        if (domain === "*") return true;
        if (domain.startsWith("*.")) {
            const base = domain.slice(2);
            return origin === base || origin.endsWith(`.${base}`);
        }
        return origin === domain;
    });
}

function validDimension(n) {
    const v = Number.parseInt(n ?? "0", 10);
    return Number.isFinite(v) && v >= 0 && v <= 4096 ? v : null;
}
function validQuality(q) {
    const v = Number.parseInt(q ?? "75", 10);
    return Number.isFinite(v) && v >= 1 && v <= 100 ? v : null;
}

const HEADER_WHITELIST = [
    "content-type",
    "cache-control",
    "content-length",
    "etag",
    "last-modified",
];

// Add CORS headers to allow all origins
function addCorsHeaders(headers) {
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    return headers;
}

Bun.serve({
    port: 3000,
    async fetch(req) {
        const url = new URL(req.url);

        // Handle preflight requests
        if (req.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: addCorsHeaders(new Headers())
            });
        }

        if (url.pathname === "/") {
            const headers = addCorsHeaders(new Headers({ "Content-Type": "text/html" }));
            return new Response(
                `<h3>Next Image Transformation v${version}</h3>More info <a href="https://github.com/coollabsio/next-image-transformation">GitHub</a>.`,
                { headers }
            );
        }
        if (url.pathname === "/health") {
            return new Response("OK", {
                headers: addCorsHeaders(new Headers())
            });
        }

        if (url.pathname.startsWith("/image/")) {
            try {
                const cached = await getCached(url);
                if (cached) return cached;
                return await resize(url);
            } catch (e) {
                console.error(e);
                return new Response("Bad request", {
                    status: 400,
                    headers: addCorsHeaders(new Headers())
                });
            }
        }
        return Response.redirect(
            "https://github.com/coollabsio/next-image-transformation",
            302,
        );
    },
});

async function resize(url) {
    const src = url.pathname.split("/").slice(2).join("/");
    let srcUrl;
    try {
        srcUrl = new URL(src);
    } catch {
        return new Response("Invalid src URL", {
            status: 400,
            headers: addCorsHeaders(new Headers())
        });
    }

    if (!["http:", "https:"].includes(srcUrl.protocol))
        return new Response("Unsupported protocol", {
            status: 400,
            headers: addCorsHeaders(new Headers())
        });
    if (srcUrl.port && !["", "80", "443"].includes(srcUrl.port))
        return new Response("Unsupported port", {
            status: 400,
            headers: addCorsHeaders(new Headers())
        });

    const origin = srcUrl.hostname.toLowerCase();
    if (!domainAllowed(origin))
        return new Response(
            `Domain (${origin}) not allowed. See docs for configuration.`,
            {
                status: 403,
                headers: addCorsHeaders(new Headers())
            }
        );

    const width = validDimension(url.searchParams.get("width"));
    const height = validDimension(url.searchParams.get("height"));
    const quality = validQuality(url.searchParams.get("quality"));
    if (width === null || height === null || quality === null)
        return new Response("Invalid parameters", {
            status: 400,
            headers: addCorsHeaders(new Headers())
        });

    const preset = "pr:sharp/f:webp";
    const urlString = `${imgproxyUrl}/${preset}/resize:fill:${width}:${height}/q:${quality}/plain/${src}`;

    const image = await fetch(urlString, {
        headers: { Accept: "image/avif,image/webp,image/apng,*/*" },
    });
    if (!image.ok) return new Response("Error fetching image", {
        status: 502,
        headers: addCorsHeaders(new Headers())
    });

    const contentType = image.headers.get("Content-Type") ?? "";
    if (!contentType.startsWith("image/"))
        return new Response("Unsupported media type", {
            status: 415,
            headers: addCorsHeaders(new Headers())
        });

    const headers = new Headers();
    HEADER_WHITELIST.forEach((h) => {
        const v = image.headers.get(h);
        if (v) headers.set(h, v);
    });
    headers.set("Server", "NextImageTransformation");
    addCorsHeaders(headers);

    const imageArrayBuffer = await image.arrayBuffer();
    await writeImageToCache(url, imageArrayBuffer, headers);
    return getCached(url); // вернём из кеша, чтобы не дублировать код
}

async function writeImageToCache(
    url,
    image,
    headers
) {
    const cacheKey = encodeURIComponent(url.pathname + url.search + version);
    const path = "./cache/" + cacheKey;
    const metaPath = path + ".meta";
    await Bun.write(path, image);
    await Bun.write(
        metaPath,
        JSON.stringify({ headers: Object.fromEntries(headers), cachedAt: Date.now() }),
    );
}

async function getCached(url) {
    const cacheKey = encodeURIComponent(url.pathname + url.search + version);
    const file = Bun.file("./cache/" + cacheKey);
    const metaFile = Bun.file("./cache/" + cacheKey + ".meta");
    if (!(await file.exists()) || !(await metaFile.exists())) return null;

    const metaData = JSON.parse(await metaFile.text());
    if (Date.now() - metaData.cachedAt > cacheInvalidationTime * 1000) return null;

    const headers = new Headers(metaData.headers);
    addCorsHeaders(headers);
    return new Response(file, { headers });
}
