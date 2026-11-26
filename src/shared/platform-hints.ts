// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cheap pre-filter for "is this a site where anyone can publish?". It only
 * decides whether a content script should ask the service worker; the engine
 * (`analyzeUrl(...).meta.platform`) stays the authority. A unit test checks
 * that every platform host the engine knows is covered here.
 *
 * Format: host suffix, optionally followed by the path prefixes that hold
 * user content on that host.
 */
const HINTS: ReadonlyArray<readonly [string, ...string[]]> = [
  ['chatgpt.com', '/share/', '/s/', '/g/'],
  ['chat.openai.com', '/share/', '/s/', '/g/'],
  ['claude.ai', '/share/', '/public/artifacts/'],
  ['claude.site'],
  ['gemini.google.com', '/share/', '/gem/'],
  ['g.co', '/gemini/share/'],
  ['copilot.microsoft.com', '/shares/'],
  ['grok.com', '/share/'],
  ['perplexity.ai', '/search/', '/page/'],
  ['poe.com', '/s/'],
  ['docs.google.com', '/forms/', '/presentation/', '/document/', '/drawings/', '/spreadsheets/'],
  ['dropbox.com', '/s/', '/scl/', '/sh/', '/t/'],
  ['app.box.com', '/s/'],
  ['box.com', '/s/'],
  ...(
    'notion.site forms.gle sites.google.com script.google.com script.googleusercontent.com drive.google.com ' +
    'drive.usercontent.google.com storage.googleapis.com storage.cloud.google.com web.app firebaseapp.com ' +
    'firebasestorage.googleapis.com forms.office.com forms.microsoft.com sharepoint.com onedrive.live.com 1drv.ms ' +
    'jotform.com jotform.me typeform.com gitbook.io wixsite.com wixstudio.io weebly.com weeblysite.com webflow.io ' +
    'framer.app framer.website framer.ai godaddysites.com square.site carrd.co canva.site mystrikingly.com ' +
    'strikingly.com blogspot.com wordpress.com telegra.ph te.legra.ph myshopify.com github.io githubusercontent.com ' +
    'gist.github.com app.github.dev gitlab.io pages.dev workers.dev r2.dev vercel.app netlify.app glitch.me ' +
    'replit.app repl.co replit.dev onrender.com herokuapp.com fly.dev up.railway.app deno.dev surge.sh ' +
    '000webhostapp.com infinityfreeapp.com epizy.com rf.gd azurewebsites.net azurestaticapps.net ' +
    'web.core.windows.net azureedge.net azurefd.net blob.core.windows.net amazonaws.com cloudfront.net ' +
    'amplifyapp.com ondigitalocean.app digitaloceanspaces.com ipfs.io dweb.link cloudflare-ipfs.com ' +
    'gateway.pinata.cloud mypinata.cloud w3s.link nftstorage.link infura-ipfs.io fleek.co 4everland.io ' +
    'ngrok.io ngrok-free.app ngrok.app ngrok-free.dev trycloudflare.com loca.lt serveo.net lhr.life ' +
    'localhost.run pinggy.link devtunnels.ms dropboxusercontent.com mega.nz mega.io mediafire.com wetransfer.com ' +
    'we.tl cdn.discordapp.com media.discordapp.net transfer.sh gofile.io pixeldrain.com file.io catbox.moe ' +
    'sendspace.com 4shared.com filebin.net temp.sh bashupload.com oshi.at uguu.se tmpfiles.org pastebin.com ' +
    'paste.ee rentry.co rentry.org hastebin.com controlc.com justpaste.it termbin.com 0x0.st ix.io sprunge.us ' +
    'paste.rs dpaste.com dpaste.org pastes.io sourceforge.net sourceforge.io linktr.ee bio.link beacons.ai ' +
    'lnk.bio linkin.bio'
  )
    .split(' ')
    .map((h) => [h] as const),
];

/** True when the page might be user-published content on a well-known platform. */
export function isPlatformHint(hostname: string, pathname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  const p = pathname.toLowerCase();
  for (const [host, ...paths] of HINTS) {
    if (h !== host && !h.endsWith(`.${host}`)) continue;
    if (paths.length === 0 || paths.some((prefix) => p.startsWith(prefix))) return true;
  }
  return false;
}
