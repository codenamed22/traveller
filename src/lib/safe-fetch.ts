import { lookup } from "node:dns/promises";
import { Agent, request } from "undici";
import ipaddr from "ipaddr.js";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { mapsQuery } from "./import";

export function isPublicAddress(address: string) {
  try {
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) parsed = (parsed as ipaddr.IPv6).toIPv4Address();
    return parsed.range() === "unicast";
  } catch { return false; }
}

export function validatePublicUrl(input: string) {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) throw new Error("Only public HTTPS links without credentials or custom ports are supported.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || (ipaddr.isValid(hostname) && !isPublicAddress(hostname))) throw new Error("Private network addresses are not supported.");
  return url;
}

export async function fetchPublicText(input: string): Promise<string> {
  let url = validatePublicUrl(input);
  const signal = AbortSignal.timeout(10_000);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const mapped = mapsQuery(url);
    if (mapped) return mapped;
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = await lookup(hostname, { all: true });
    if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) throw new Error("This link resolves to a private or reserved address.");
    const dispatcher = new Agent({ connect: { lookup: (_hostname, options, callback) => {
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    } } });
    try {
      const response = await request(url, { dispatcher, signal, headers: { "accept-encoding": "identity", "user-agent": "Traveller/0.1 (itinerary import)", accept: "text/html,text/plain" } });
      if (response.statusCode >= 300 && response.statusCode < 400) {
        const location = response.headers.location;
        response.body.destroy();
        if (typeof location !== "string" || redirects === 3) throw new Error("Too many redirects or an invalid link.");
        url = validatePublicUrl(new URL(location, url).href);
        continue;
      }
      if (response.statusCode !== 200) { response.body.destroy(); throw new Error("This page is not accessible. Paste its itinerary text instead."); }
      const encoding = response.headers["content-encoding"];
      const contentType = String(response.headers["content-type"] ?? "");
      if ((encoding && encoding !== "identity") || !/^(text\/html|text\/plain)/i.test(contentType)) { response.body.destroy(); throw new Error("This link is not an accessible text page. Upload the document instead."); }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 1_000_000) { response.body.destroy(); throw new Error("This page is too large. Paste the relevant itinerary section instead."); }
        chunks.push(Buffer.from(chunk));
      }
      const text = Buffer.concat(chunks).toString("utf8");
      if (contentType.startsWith("text/plain")) return text.slice(0, 30_000);
      const { document } = parseHTML(text);
      document.querySelectorAll("script,style,iframe,form").forEach((element) => element.remove());
      const article = new Readability(document as unknown as Document).parse();
      const extracted = article?.textContent?.trim();
      if (!extracted) throw new Error("No itinerary text found. Paste the relevant text instead.");
      return extracted.slice(0, 30_000);
    } finally { await dispatcher.close(); }
  }
  throw new Error("Unable to import this link.");
}