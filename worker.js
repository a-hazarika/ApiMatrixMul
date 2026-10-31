// merrykin-books worker (dl.merrykin.com)
//  - /d/<key>/<order>/<sig>?n=<name>&c=<coverId>   signed, personalised PDF (download, Lulu interior or Lulu cover)
//  - /api/preview  (public)  photo -> Gemini -> clean image kept server-side, watermarked low-res preview returned
//  - /pv/<id>                watermarked preview image (the clean image is never served to browsers)
//  - /hook/shopify           Shopify "Order payment" webhook (HMAC) -> /hook/order logic -> Lulu print jobs
//  - /admin/*                x-admin header: KV get/put, sign, gen, lulu proxy, pages
// Base PDFs carry overridable objects (meta.obj = name stream, meta.coverObj = cover image); a download
// appends a PDF incremental update, so no PDF parsing happens at request time (fits the free CPU limit).
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,PUT,POST,OPTIONS', 'access-control-allow-headers': 'x-admin,content-type' };
const enc = new TextEncoder();
const DAY = 86400, KEEP = 30 * DAY; // uploads and previews are deleted after 30 days

async function sign(secret, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const s = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
  return [...s].map(b => b.toString(16).padStart(2, '0')).join('');
}
// signed message: key|order|name|cover  (Shopify Liquid builds the same string with hmac_sha256)
const sigFor = (env, key, order, name, cover) => sign(env.SECRET, `${key}|${order}|${name}|${cover}`).then(s => s.slice(0, 32));

function update(meta, name, cover) {
  const parts = [], xref = []; let off = meta.baseLen;
  const push = u8 => { parts.push(u8); off += u8.length; };
  if (name && meta.obj) {
    let hex = '', w = 0;
    for (const ch of name) { const g = meta.map[ch]; if (g) { hex += g[0]; w += g[1]; } }
    let size = meta.size; if (w * size / 1000 > meta.maxW) size = meta.maxW * 1000 / w;
    const x = (meta.cx - w * size / 2000).toFixed(2);
    const ops = `Q q ${meta.rgb} rg BT /${meta.font} ${size.toFixed(2)} Tf 1 0 0 1 ${x} ${meta.y} Tm <${hex}> Tj ET Q`;
    xref.push([meta.obj, off + 1]); push(enc.encode(`\n${meta.obj} 0 obj\n<< /Length ${ops.length} >>\nstream\n${ops}\nendstream\nendobj\n`));
  }
  if (cover && meta.coverObj) { // cover: baseline JPEG, exactly 2550x3300
    xref.push([meta.coverObj, off + 1]);
    push(enc.encode(`\n${meta.coverObj} 0 obj\n<< /Type /XObject /Subtype /Image /Width 2550 /Height 3300 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${cover.length} >>\nstream\n`));
    push(cover); push(enc.encode('\nendstream\nendobj\n'));
  }
  if (!xref.length) return [];
  const at = off;
  push(enc.encode('xref\n0 1\n0000000000 65535 f \n' + xref.map(([n, o]) => `${n} 1\n${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${meta.sizeObj} /Root ${meta.root} /Prev ${meta.prev} >>\nstartxref\n${at}\n%%EOF\n`));
  return parts;
}

async function download(env, key, order, sig, name, cover) {
  if (await sigFor(env, key, order, name, cover) !== sig)
    return new Response('This download link is not valid. Please reply to your order email and we will help: hello@merrykin.com', { status: 403 });
  const meta = await env.BOOKS.get('meta:' + key, 'json');
  if (!meta) return new Response('Book not found', { status: 404 });
  let cov = null;
  if (cover) cov = await env.BOOKS.get('clean:' + cover, 'arrayBuffer');           // customer's approved cartoon cover
  else if (meta.coverKey) cov = await env.BOOKS.get(meta.coverKey, 'arrayBuffer'); // e.g. the "20 PICTURES" cover
  const parts = update(meta, name, cov && new Uint8Array(cov));
  const extra = parts.reduce((a, p) => a + p.length, 0);
  const base = await env.BOOKS.get('base:' + key, 'stream');
  const { readable, writable } = new FixedLengthStream(meta.baseLen + extra);
  (async () => { await base.pipeTo(writable, { preventClose: true }); const w = writable.getWriter(); for (const p of parts) await w.write(p); await w.close(); })();
  const file = `${meta.title}${name ? ' - ' + name : ''}.pdf`.replace(/[^\w .,'-]/g, '');
  return new Response(readable, { headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${file}"`, 'cache-control': 'private, no-store' } });
}

// ---------- AI previews ----------
const PALETTE = { '': 'deep red, forest green and cream', evergreen: 'deep forest green, red, cream and gold', navy: 'midnight navy blue, white, icy light blue and silver (no red, no green)', candy: 'cream white, candy-cane red and green', plainred: 'cherry red with cream and green accents', plaingreen: 'forest green with cream and red accents', plainnavy: 'midnight navy with white and light blue accents' };
const LAYOUT = (p) => /^plain/.test(p || '') ? ' IMPORTANT, simple style: keep the body plain solid knit exactly like image 2, with the fair-isle band only at the very top and bottom edges. Put the family in the centre of the chest with a small ring of knitted snowflakes and stars around them, and leave the rest plain.' : '';
const LIKE = 'Keep every person and pet instantly recognisable to their own family: carry over each real face shape, eye shape and colour, eyebrows, nose, smile, skin tone, freckles or dimples, hair colour, texture, length and style, glasses and facial hair, and each one\'s real age and ethnicity. Simplify only as much as the cartoon style needs, never into generic faces, and never make two people look alike.';
const PROMPTS = {
  cover: (o) => `Image 1 is a photo of a child${o.who ? ` (${o.who})` : ''}. Image 2 is a children's book cover. Edit image 2: add ONE new character, a cute cartoon version of that child, drawn in exactly the same illustration style as the cover (bold clean outlines, soft shading, rounded friendly proportions, same lighting). LIKENESS COMES FIRST: their parent must instantly recognise this exact child. Carry the real face from image 1 into the cartoon feature by feature: face shape, cheeks and chin; eye shape, size, spacing and colour; eyebrow shape and thickness; nose shape; mouth and smile, including any gaps or missing teeth; ears if visible; dimples, freckles, moles or birthmarks; their exact skin tone; their hairline and parting; hair colour, texture (straight, wavy, curly or coily), length and style; glasses if they wear them. Keep their real age and ethnicity. Simplify only as much as the cover's style needs: never swap in a generic cartoon face, never change the hairstyle, and never lighten or darken the skin.${o.notes ? ' Notes from the parent: ' + o.notes + '.' : ''} Dress the child in a cozy ${o.slug === 'winter-lantern-story' ? 'winter' : 'Christmas'} outfit; do NOT copy clothing, costumes, logos or characters from the photo. Place the child front and centre among the existing characters, clearly visible and happy. Keep everything else exactly the same: all text, characters, colours and layout. Do not add any text. Output the complete portrait cover.`,
  page: (o) => `Turn this photo into a page for a ${o.style === 'grownup' ? 'detailed coloring book for adults' : "children's coloring book for ages 4-8"}. Pure black line art on a pure white background: no grey, no shading, no fills, no colour at all. ${o.style === 'grownup' ? 'Clean confident outlines with pleasant detail.' : 'Very thick, smooth outlines, simple shapes and large open areas that are easy to color.'} Keep the people recognisable (pose, hairstyle, clothing shapes) and keep the main scene; drop small clutter. Make anything scary friendly. Remove all brand logos, licence plates and text. Portrait page with a clean white margin. Output only the line art.`,
  scene: (o) => `Turn this photo into a colourful, joyful Christmas cartoon illustration for a ${o.garment || 'T-shirt'} print. Draw every person and pet from the photo in a cute, rounded cartoon style with bold clean outlines. ${LIKE} Put them in a cozy festive scene: snow, twinkling lights, a decorated tree, wrapped gifts${o.notes ? '; ' + o.notes : ''}. Dress them in Christmas sweaters and Santa hats; do not copy logos, costumes or characters from the photo. Centred composition on a plain white background with soft edges so it prints nicely. No text.`,
  sweater: (o) => `Image 1 is a photo of a family (people and/or pets). Image 2 is ugly Christmas sweater knit fabric. Create the FRONT panel of an ugly Christmas sweater as ONE seamless knitted design that fills the whole frame edge to edge. Copy the fair-isle pattern, its motifs and its chunky knit stitch texture from image 2 all around. Use ONLY these yarn colours for the knit pattern: ${PALETTE[o.pattern] || PALETTE['']}${o.tonal ? '; knit the family in these same yarn colours too, a tonal look that matches the sweater' : '; the family itself keeps natural skin tones, hair colours and colourful Christmas outfits'}. In the middle of the chest, knit a cute cartoon of everyone from the photo INTO the fabric: drawn with the same visible knit stitches and yarn colours so they look knitted, blending straight into the surrounding pattern with no border, box, frame, patch or white background. Include EVERY person and pet from the photo (count them; nobody missing, nobody added) and give them Santa hats. ${LIKE}${o.notes ? ' Notes: ' + o.notes + '.' : ''} Do not copy logos or characters from the photo.${LAYOUT(o.pattern)} Flat front-on view of the knitted fabric only: no garment outline, no folds, no text.`,
  socks: (o) => `Image 1 is a photo of a pet (or several pets). Design ONE square repeating pattern tile for all-over printed Christmas socks. Background: flat warm cream (#F7F1E6) everywhere. On it, cute cartoon HEADS of the pet(s) from the photo, each wearing a little red Santa hat, arranged in a neat staggered grid: 3 rows, 2 heads in rows 1 and 3, 3 heads in the middle row, all the same size, every head facing forward. Between the heads, scatter small simple Christmas motifs in deep red (#9C1C20) and forest green (#1F5C43): holly leaves, candy canes, snowflakes, tiny stars. Keep every pet instantly recognisable to its owner: the exact fur colours and markings, ear shape, eye colour, nose and muzzle shape, collar if visible.${o.notes ? ' Notes: ' + o.notes + '.' : ''} Bold clean outlines, flat bright colours, no shading on the background. IMPORTANT: nothing may touch or cross the edges of the square; leave a clear cream margin on all four sides so the tile repeats seamlessly. No text, no logos, no frame.`,
  sweater_cutout: (o) => `Image 1 is a photo of a family (people and/or pets). Image 2 is ugly Christmas sweater knit fabric. Create the FRONT panel of an ugly Christmas sweater that fills the whole frame edge to edge: the same fair-isle knit pattern, motifs and chunky stitch texture as image 2 everywhere, using ONLY these yarn colours: ${PALETTE[o.pattern] || PALETTE['']}. On the middle of the chest, place a colourful cute cartoon of everyone from the photo (bold clean outlines, soft shading, Santa hats, cozy Christmas sweaters) as ONE die-cut sticker: a thick, clean white outline follows the outside shape of the group, like a vinyl sticker, and the knit pattern shows all around it. No rectangle, box or square background behind them. Include EVERY person and pet from the photo (count them; nobody missing, nobody added). ${LIKE}${o.notes ? ' Notes: ' + o.notes + '.' : ''} Do not copy logos or characters from the photo.${LAYOUT(o.pattern)} Flat front-on view: no garment outline, no folds, no text.`
};

async function gemini(env, prompt, images, aspect, size) {
  const parts = [{ text: prompt }, ...images.map(i => ({ inline_data: { mime_type: i.mime, data: i.data } }))];
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${env.GEN_MODEL || 'gemini-3.1-flash-image'}:generateContent`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_KEY || env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['IMAGE', 'TEXT'], imageConfig: { aspectRatio: aspect, imageSize: size } } })
  });
  // A 4K image is ~20 MB of JSON. Slice the base64 out of the text instead of JSON.parse (which copies it again) to stay under 128 MB.
  const t = await r.text(), k = Math.max(t.indexOf('"inlineData"'), t.indexOf('"inline_data"')), i = k < 0 ? -1 : t.indexOf('"data"', k);
  if (i < 0) { let j = {}; try { j = JSON.parse(t); } catch (e) {} throw new Error(j.candidates?.[0]?.finishReason || j.error?.message || 'no image'); }
  const s = t.indexOf('"', t.indexOf(':', i) + 1) + 1, data = t.slice(s, t.indexOf('"', s));
  return Uint8Array.fromBase64 ? Uint8Array.fromBase64(data) : Uint8Array.from(atob(data), c => c.charCodeAt(0)); // native decode: keeps CPU low
}
const b64 = (buf) => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode(...u.subarray(i, i + 32768)); return btoa(s); };
const toStream = (u8) => new Response(u8).body;

async function limited(env, ip) { // ponytail: KV counter is eventually consistent; good enough to stop casual abuse
  const k = `rl:${ip}:${new Date().toISOString().slice(0, 13)}`; const n = +(await env.BOOKS.get(k) || 0);
  if (n >= (+env.RATE_PER_HOUR || 15)) return true;
  await env.BOOKS.put(k, String(n + 1), { expirationTtl: 3600 * 2 }); return false;
}

async function preview(req, env) {
  const ip = req.headers.get('cf-connecting-ip') || 'x';
  if (await limited(env, ip)) return json({ error: 'You have made a lot of previews. Please try again in an hour.' }, 429);
  const o = await req.json();
  if (!o.photo || o.photo.length > 4e6) return json({ error: 'Please upload a photo under 3 MB.' }, 400);
  const kind = PROMPTS[o.kind] ? o.kind : 'cover';
  const images = [{ mime: 'image/jpeg', data: o.photo }];
  let aspect = '1:1', w = 2400, h = 2400;
  if (kind === 'cover') {
    const cov = await env.BOOKS.get((o.twenty ? 'raw:cover20:' : 'raw:cover:') + o.slug, 'arrayBuffer');
    if (!cov) return json({ error: 'Unknown book' }, 400);
    images.push({ mime: 'image/jpeg', data: b64(cov) }); aspect = '3:4'; w = 2550; h = 3300;
  } else if (kind === 'page') { aspect = '3:4'; w = 2550; h = 3300; }
  else if (kind === 'sweater' || kind === 'sweater_cutout') { images.push({ mime: 'image/jpeg', data: b64(await env.BOOKS.get('raw:knit-ref' + pat(o.pattern), 'arrayBuffer')) }); aspect = '3:4'; w = 3600; h = 4716; } // AOP front panel ratio
  let img;
  try { img = await gemini(env, PROMPTS[kind](o), images, aspect, '4K'); }
  catch (e) { return json({ error: "We couldn't make this one. Try a clearer, closer photo of one face (no sunglasses or filters)." }, 422); }
  const id = crypto.randomUUID().replace(/-/g, '');
  // clean, print-size JPEG stays server-side; browsers only ever get the watermarked low-res copy
  const clean = await (await env.IMAGES.input(toStream(img)).transform({ width: w, height: h, fit: 'cover' }).output({ format: 'image/jpeg', quality: 92 })).response().arrayBuffer();
  const wm = await env.BOOKS.get('raw:wm.png', 'stream');
  const shown = await (await env.IMAGES.input(toStream(img)).transform({ width: 900 })
    .draw(env.IMAGES.input(wm), { opacity: 1, repeat: true })
    .output({ format: 'image/jpeg', quality: 72 })).response().arrayBuffer();
  await env.BOOKS.put('clean:' + id, clean, { expirationTtl: KEEP, metadata: { kind, slug: o.slug || '', t: Date.now() } });
  await env.BOOKS.put('wm:' + id, shown, { expirationTtl: KEEP });
  let cut; // tees, sweatshirts and hoodies print the cartoon cut out of its background: give the page that shape (watermarked) for the garment mockup
  if (kind === 'scene') try {
    await env.BOOKS.put('wmc:' + id, await (await env.IMAGES.input(toStream(shown)).transform({ segment: 'foreground' }).output({ format: 'image/png' })).response().arrayBuffer(), { expirationTtl: KEEP });
    cut = `https://dl.merrykin.com/pvc/${id}`;
  } catch (e) {}
  if (o.keepPhoto) await env.BOOKS.put('photo:' + id, Uint8Array.from(atob(o.photo), c => c.charCodeAt(0)), { expirationTtl: KEEP });
  return json({ id, preview: `https://dl.merrykin.com/pv/${id}`, cut });
}
// Lifestyle product photos. Each slug/scene is made once from the real cover and then served from KV,
// so the public route can cost at most 9 books x 4 scenes of Gemini calls.
const SAMPLES = [{"slug": "christmas-toddler", "title": "Christmas Fun", "subtitle": "Christmas Coloring Book for Toddlers, Ages 1-4", "lead": "50 big and simple Christmas pictures for toddlers ages 1 to 4, with a word under each one.", "more": "Trees, stockings, snowmen, reindeer, gifts and cookies, drawn with very thick lines and big open shapes that little hands can color. Single-sided pages.", "tags": ["printable coloring pages", "kids coloring", "toddler activities", "preschool printables", "homeschool", "classroom activity", "christmas", "toddler", "preschool", "holiday"], "min": "", "amazon": "", "ai": "AI-generated cover art. Line art drawn by code; text written with Claude."}, {"slug": "christmas-cozy-animals", "title": "Christmas Animals", "subtitle": "Christmas Coloring Book for Kids, Ages 4-8", "lead": "50 bold and easy pictures of cute animals at Christmas, for kids ages 4 to 8.", "more": "Bears, bunnies, foxes, penguins and more decorate the tree, bake cookies, sip cocoa and build snowmen. Round, friendly characters with thick lines.", "tags": ["printable coloring pages", "kids coloring", "toddler activities", "preschool printables", "homeschool", "classroom activity", "christmas", "cozy", "animals", "cute"], "min": "", "amazon": "", "ai": "AI-generated cover art. Line art drawn by code; text written with Claude."}, {"slug": "christmas-bedtime-story", "title": "Christmas Bedtime Story", "subtitle": "A Christmas Read-Aloud Story to Color", "lead": "A gentle Christmas Eve story to read aloud, told in 40 pictures to color, for kids ages 3 to 7.", "more": "Tilly the little fox cannot sleep on Christmas Eve. Follow her through the snow as she makes friends and helps a lost reindeer calf. Each page has a short line of story and a bold picture to color, with a sleepy ending.", "tags": ["printable coloring pages", "kids coloring", "toddler activities", "preschool printables", "homeschool", "classroom activity", "christmas", "bedtime story", "read aloud", "story"], "min": "", "amazon": "", "ai": "AI-generated cover art. Line art drawn by code; text written with Claude."}, {"slug": "christmas-kids", "title": "Christmas Joy", "subtitle": "Christmas Coloring Book for Kids, Ages 4-8", "lead": "50 bold and easy Christmas pictures for kids ages 4 to 8: Santa, elves, reindeer, snowmen, winter animals and cozy scenes.", "more": "Thick lines and big open spaces make every page easy to color. Cute original characters, one main subject per page, and a few fun extras.", "tags": ["printable coloring pages", "kids coloring", "toddler activities", "preschool printables", "homeschool", "classroom activity", "christmas", "santa", "winter", "holiday"], "min": "", "amazon": "", "ai": "AI-generated cover art. Line art drawn by code; text written with Claude."}, {"slug": "christmas-dot-marker", "title": "Christmas Dot Marker", "subtitle": "Christmas Dot Marker Book for Toddlers", "lead": "50 big dot pictures for toddlers ages 1 to 4: dab, dab, dab with a dot marker or a dauber.", "more": "Every picture is drawn with a bold outline and big empty circles to dab: a Christmas tree, snowman, gift, stocking and more. Perfect for little fingers, dot markers, bingo daubers, stickers, or crayons for the outlines. A word label under each picture.", "tags": ["printable coloring pages", "kids coloring", "toddler activities", "preschool printables", "homeschool", "classroom activity", "dot marker", "christmas", "toddler", "fine motor"], "min": "2026-11-01", "amazon": "", "ai": "AI-generated cover art. Line art drawn by code; text written with Claude."}, {"slug": "christmas-story-snowman", "title": "Sleepy Snowman", "subtitle": "A Christmas Read-Aloud Story to Color", "lead": "A sleepy snowman, a snowy night and a cozy ending: a read-aloud Christmas story with 40 pictures to color, for kids ages 3 to 7.", "more": "Flake the snowman cannot stop yawning on Christmas Eve, but every place to sleep is too bright, too cold or too prickly. His woodland friends try to help. Each page has a short line of story and a bold picture to color.", "tags": ["printable coloring pages", "kids coloring", "toddler activities", "preschool printables", "homeschool", "classroom activity", "christmas", "snowman", "story", "bedtime"], "min": "2026-11-01", "amazon": "", "ai": "AI-generated cover art. Line art drawn by code; text written with Claude."}, {"slug": "christmas-story-good-list", "title": "Santa's Good List", "subtitle": "A Christmas Read-Aloud Story to Color", "lead": "A cheerful Christmas story about two little elves who notice kindness all year long, with 40 pictures to color, for kids ages 3 to 7.", "more": "Jingle and Twig keep Santa's Good List, and all year long three kind children give them something to write: a shoveled path, a shared toy, a thirsty puppy given a drink. On Christmas Eve, Santa and the elves bring thoughtful little gifts. A short line of…", "tags": ["printable coloring pages", "kids coloring", "toddler activities", "preschool printables", "homeschool", "classroom activity", "christmas", "santa", "elves", "kindness"], "min": "2026-11-08", "amazon": "", "ai": "AI-generated cover art. Line art drawn by code; text written with Claude."}, {"slug": "winter-lantern-story", "title": "Lumi and the Winter Lights", "subtitle": "A Read-Aloud Story to Color, Ages 3-7", "lead": "A magical winter story to read aloud, told in 40 pictures to color, for kids ages 3 to 7.", "more": "On Lantern Night the whole village of Hushwood glows with lanterns, until a cold wind blows them out. Little Lumi the fox and her friend Fern the owlet set off up Frost Mountain to wake the sleeping Winter Light. Along the way they meet a lost snow bunny,…", "tags": ["printable coloring pages", "kids coloring", "bedtime story", "read aloud", "winter", "snow", "lanterns", "preschool printables", "homeschool", "story"], "min": "2026-11-08", "amazon": "", "ai": "AI-generated cover and pictures (Google Gemini). Story text written with Claude."}, {"slug": "christmas-story-star", "title": "Nova the Little Star", "subtitle": "A Christmas Read-Aloud Story to Color", "lead": "A little star falls to earth on Christmas Eve and her new friends help her shine again: a read-aloud story with 40 pictures to color, for kids ages 3 to 7.", "more": "Nova the little star lands in the snow with her twinkle gone dim. A mouse, an owl, a fox cub and a reindeer calf try everything to get her home. A kind story about sharing light, with a bold picture to color on every page.", "tags": ["printable coloring pages", "kids coloring", "toddler activities", "preschool printables", "homeschool", "classroom activity", "christmas", "star", "story", "kindness"], "min": "2026-11-15", "amazon": "", "ai": "AI-generated cover art. Line art drawn by code; text written with Claude."}, {"slug": "christmas-story-bakery", "title": "Christmas Bakery", "subtitle": "A Christmas Read-Aloud Story to Color", "lead": "A little mouse baker and her friends bake cookies for the whole snowy wood: a read-aloud Christmas story with 40 pictures to color, for kids ages 3 to 7.", "more": "Mabel the mouse and her friends bake, decorate and deliver a cookie to every door in the woods before midnight. A cozy story about giving, with a bold picture to color on every page.", "tags": ["printable coloring pages", "kids coloring", "toddler activities", "preschool printables", "homeschool", "classroom activity", "christmas", "bakery", "story", "cookies"], "min": "2026-11-15", "amazon": "", "ai": "AI-generated cover art. Line art drawn by code; text written with Claude."}];
// Free 5-page sample PDFs (/sample/list.json, /sample/<slug>-<letter|a4>.pdf, /sample/cover-<slug>.jpg).
// The first two go live with the store, then one every SAMPLE_GAP days in SAMPLES order, never before the book's Amazon date (min).
// Launch day is detected the first time merrykin.com answers without the password page, and kept in KV cfg:launch.
const SAMPLE_GAP = 3;
async function sampleLaunch(env) {
  const d = await env.BOOKS.get('cfg:launch'); if (d) return d;
  const r = await fetch('https://merrykin.com/', { redirect: 'manual' }).catch(() => null);
  if (!r || r.status !== 200) return null; // still behind the password page
  const t = new Date().toISOString().slice(0, 10); await env.BOOKS.put('cfg:launch', t); return t;
}
async function sampleList(env) {
  const launch = await sampleLaunch(env), base = Date.parse(launch || new Date().toISOString().slice(0, 10)), now = Date.now();
  return { launch, items: SAMPLES.map((s, i) => {
    const date = new Date(Math.max(base + Math.max(0, i - 1) * SAMPLE_GAP * DAY * 1000, s.min ? Date.parse(s.min) : 0)).toISOString().slice(0, 10);
    return { ...s, date, live: !!launch && Date.parse(date) <= now };
  }) };
}
async function sample(env, name) {
  const H = { ...CORS, 'cache-control': 'public, max-age=300' };
  if (name === 'list.json') { const l = await sampleList(env); return new Response(JSON.stringify(l), { headers: { ...H, 'content-type': 'application/json' } }); }
  let m = /^cover-([a-z-]+)\.jpg$/.exec(name);
  if (m) { const v = await env.BOOKS.get('sample:cover-' + m[1], 'arrayBuffer'); return v ? new Response(v, { headers: { ...H, 'cache-control': 'public, max-age=86400', 'content-type': 'image/jpeg' } }) : new Response('not found', { status: 404 }); }
  m = /^([a-z-]+)-(letter|a4)\.pdf$/.exec(name);
  const s = m && (await sampleList(env)).items.find(x => x.slug === m[1]);
  if (!s || !s.live) return new Response('This free sample is not out yet. See merrykin.com/pages/free-coloring-pages', { status: 404, headers: H });
  const v = await env.BOOKS.get('sample:' + m[1] + '-' + m[2], 'arrayBuffer');
  return new Response(v, { headers: { ...H, 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${s.title.replace(/[^\w ]/g, '')} - free sample (${m[2] === 'a4' ? 'A4' : 'US Letter'}) - Wobbly Crayon Books.pdf"` } });
}
const LIFE_BOOKS = ['winter-lantern-story', 'christmas-toddler', 'christmas-kids', 'christmas-cozy-animals', 'christmas-dot-marker', 'christmas-bedtime-story', 'christmas-story-bakery', 'christmas-story-good-list', 'christmas-story-snowman', 'christmas-story-star'];
const FAMILIES = ['a Black family', 'a white family', 'a South Asian family', 'an East Asian family', 'a Latino family', 'a mixed-race family'];
// Scenes for /life/<slug>-<0..3>.jpg. Open-book scenes are generated from a real spread of the book (KV spread:<slug>):
// left page = plain back of the previous sheet, right page = the one picture (with its story line in story books).
const LIFE_COLOR = [
  'A happy toddler (about 2-3) colouring this book with chunky crayons at a cosy kitchen table, while their mum sits ACROSS the table facing the camera, smiling warmly as she watches. The photo is taken from directly BEHIND the toddler, over their shoulder: the back of the toddler\'s head and one shoulder are in the near foreground and their hand holds the crayon on the page. We do not see the toddler\'s face.',
  'A child (about 5) kneeling at a low coffee table beside a twinkling Christmas tree, colouring this book, while their grandma sits on the sofa ACROSS the table facing the camera, smiling. The photo is taken from directly BEHIND the child, over their shoulder: the back of their head and one shoulder are in the near foreground and their hand colours the page. We do not see the child\'s face.',
  'Two siblings sitting side by side sharing this ONE book at the dining table: one colours the picture while the other points at it. Their dad sits ACROSS the table facing the camera, laughing; mugs of cocoa nearby. The photo is taken from directly BEHIND the two children: the backs of their heads and shoulders are in the near foreground. We do not see the children\'s faces, and nobody else is on the near side of the table. Every hand and crayon is on the RIGHT-hand picture page; nothing touches the plain patterned left page.',
  'CLOSED: A child (about 4) on Christmas morning who has just unwrapped this book, holding it up with both hands, beaming, torn wrapping paper around them and their mum smiling beside them.'];
const LIFE_FIX = {
  'christmas-dot-marker-0': { extra: ' Exactly two books in the whole picture: the open dot marker book and ONE closed copy of image 3.' },
  'christmas-dot-marker-2': { other: null, extra: ' Seen from the children\'s side of the table, the plain patterned page is on THEIR LEFT and the dot picture page is on THEIR RIGHT, the right way up for them.' },
  'christmas-dot-marker-3': { other: 'christmas-story-good-list', extra: ' The only other book in the room is image 3 (Santa\'s Good List), standing on the side table; there is no second Christmas Dot Marker book anywhere.' },
};
const LIFE_STORY = 'A mum reading this book aloud to her child (about 4) snuggled beside her in bed under a warm blanket. The photo is taken from just behind and above their shoulders, so the open book in her hands is the right way up for them and for the camera. The child points straight at the coloured-in picture on the RIGHT-hand page with a big amazed smile; nobody points at the plain patterned left page.';
async function life(env, name) {
  const m = /^([a-z-]+)-([0-3])\.jpg$/.exec(name); if (!m) return new Response('not found', { status: 404 });
  const key = 'life4:' + m[1] + '-' + m[2], hit = await env.BOOKS.get(key, 'arrayBuffer');
  const ok = (v) => new Response(v, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400' } });
  if (hit) return ok(hit);
  const cov = await env.BOOKS.get('raw:cover:' + m[1], 'arrayBuffer'), spread = await env.BOOKS.get('spread:' + m[1], 'arrayBuffer');
  if (!cov || !spread) return new Response('not found', { status: 404 });
  if (await env.BOOKS.get('lock:' + key)) return new Response('busy, retry in a minute', { status: 503, headers: { 'retry-after': '60' } });
  await env.BOOKS.put('lock:' + key, '1', { expirationTtl: 180 });
  const story = /story/.test(m[1]), dots = /dot/.test(m[1]), n = +m[2];
  const fam = FAMILIES[([...m[1]].reduce((a, c) => a + c.charCodeAt(0), 0) + n) % FAMILIES.length];
  // per-photo overrides after review: other = cross-sell slug or null for none
  const fix = LIFE_FIX[m[1] + '-' + m[2]] || {};
  const i = LIFE_BOOKS.indexOf(m[1]), otherSlug = 'other' in fix ? fix.other : LIFE_BOOKS[(i + 1 + n * 2) % LIFE_BOOKS.length];
  const other = otherSlug && await env.BOOKS.get('raw:cover:' + otherSlug, 'arrayBuffer');
  let scene = (story && n === 3 ? LIFE_STORY : LIFE_COLOR[n]).replace('{FACE}', ['tongue poking out in concentration', 'beaming with delight', 'giggling happily'][i % 3]);
  const closed = scene.startsWith('CLOSED: '); scene = scene.replace('CLOSED: ', '');
  if (dots) scene = scene.replace(/chunky crayons|colouring|colours/g, (x) => x === 'chunky crayons' ? 'bright dot markers' : x === 'colours' ? 'dabs dots on' : 'dabbing dots in');
  const reading = story && n === 3;
  const fill = reading ? 'already coloured in with bright crayon from an earlier colouring session' : dots ? 'with some of its circles filled in with round dot-marker dots' : 'partly coloured in by the child with real crayon strokes';
  const book = closed
    ? `Show exactly ONE copy of this book, CLOSED, its front cover facing the camera, upright and readable, matching image 1 exactly (same art, title and colours) on a real paperback with natural lighting and perspective.`
    : `Show exactly ONE copy of this book, lying OPEN as a real 8.5 x 11 inch paperback with a glued spine and gently curving pages, open at exactly the spread in image 2: the LEFT page is only the faint light pattern from image 2 with nothing to colour, and the RIGHT page is the single picture from image 2${story ? ', with its short line of story printed in the box under the picture exactly as in image 2' : ''}, ${fill}. Only the right-hand page has a picture: never draw pictures on both pages, never show extra pages or a third page sticking out, and never invent other drawings or words on the pages. Every picture in this book is printed on its own page in the book, never on loose sheets. Because the camera looks from behind the person colouring, the book is the right way up for both of them: seen in the photo, the patterned page is on the LEFT, the picture page is on the RIGHT, and the picture is upright with its label or story line at the bottom edge nearest the camera, exactly like image 2. The picture is clearly visible. Never show the book upside down, rotated or mirrored. The front cover is not visible because the book is open.`;
  let prompt = `Image 1 is the front cover of our printed children's ${story ? 'story colouring book' : 'colouring book'} and image 2 is a real open two-page spread from inside it. Make a warm, candid lifestyle photograph for an online shop: ${scene} The people are ${fam}. ${book} ${other ? `Image 3 is a different book from our shop: include one closed copy of it as a completely separate object elsewhere in the scene (standing upright on a shelf or side table in the background, or lying flat on its own), smaller and slightly out of focus, cover the right way up and matching image 3. It must not touch, overlap, sit on, sit under or be tucked into the main book. Image 3 has a DIFFERENT title from image 1. Count the books: there are exactly TWO books in the whole picture, this one and ONE copy of image 3; never draw a second copy of either.` : 'There are no other books anywhere in the scene, only the one copy of this book.'}${fix.extra || ''} Real, natural faces with genuine joy, correct hands with five fingers, cosy Christmas home, soft golden evening light, shallow depth of field, shot on a full-frame camera, photorealistic. No other text, no logos, no watermark.`;
  if (m[1] === 'winter-lantern-story') prompt = prompt.replace('photorealistic.', 'photorealistic. Winter, not Christmas: no Christmas tree, no Santa, no Christmas stockings or ornaments; use paper lanterns, candles, fairy lights and snowy windows instead.')
  if (m[1] === 'winter-lantern-story') prompt = prompt.replace(/twinkling Christmas tree|Christmas tree/g, 'window glowing with paper lanterns').replace(/Christmas morning/g, 'a snowy winter morning').replace(/Christmas /g, 'winter ');
  try {
    const img = await gemini(env, prompt, [{ mime: 'image/jpeg', data: b64(cov) }, { mime: 'image/jpeg', data: b64(spread) }, ...(other ? [{ mime: 'image/jpeg', data: b64(other) }] : [])], '4:5', '2K');
    const jpg = await (await env.IMAGES.input(toStream(img)).transform({ width: 2000 }).output({ format: 'image/jpeg', quality: 88 })).response().arrayBuffer();
    await env.BOOKS.put(key, jpg); return ok(jpg);
  } catch (e) { await env.BOOKS.delete('lock:' + key); return new Response('failed: ' + e.message, { status: 502 }); }
}
// ---------- Personalised pencil case (Printify 356) ----------
// Print file (Printify Accessory Pouch 356, Small): 3000x3900, top half = front, bottom half = back (printed upside down).
// Front: child's name (+ optional cartoon); back: the chosen quote. Text is outlined from GLYPHS (worker/tools/glyphs.py), so no fonts are needed.
const CASE_COLOURS = {
  blush: ['#F6DADA', '#3B2A3A'], sky: ['#D7E8F5', '#1F2A44'], mint: ['#DCEFE4', '#1E3B2F'],
  cream: ['#F7F1E8', '#1E1B24'], navy: ['#1F2A44', '#F7F1E8'],
};
const GOLD = '#B08D57';
function caseText(set, s, size) { // -> [path d, width] at baseline 0, left 0
  const k = size / 1000; let x = 0, d = '';
  for (const ch of s) { const g = set[ch] || set[' ']; if (!g) continue;
    if (g[1]) d += `<path transform="translate(${(x * k).toFixed(1)} 0) scale(${k})" d="${g[1]}"/>`; x += g[0]; }
  return [d, x * k];
}
const star = (cx, cy, r) => { let p = ''; for (let i = 0; i < 10; i++) { const a = Math.PI / 5 * i - Math.PI / 2, rr = i % 2 ? r * 0.45 : r; p += (i ? 'L' : 'M') + (cx + rr * Math.cos(a)).toFixed(1) + ' ' + (cy + rr * Math.sin(a)).toFixed(1); } return `<path d="${p}Z"/>`; };
function caseSVG(G, o) {
  const [bg, ink] = CASE_COLOURS[o.colour] || CASE_COLOURS.cream, W = 3000, H = 1950;
  const clean = (s) => [...(s || '')].filter(c => G.name[c]).join('').trim().slice(0, 16) || 'Your Name';
  const name = clean(o.name), quote = G.quotes[+o.quote] || G.quotes[0];
  const fk = { script: 'script', storybook: 'story', story: 'story' }[(o.font || '').toLowerCase()];
  const font = fk && G[fk] && [...name].every(c => G[fk][c]) ? fk : 'name'; // Playful = 'name'; accents only in Playful
  // frame + stars shared by both faces (face area 3000x1950, safe ~300..2700 x 330..1800)
  const frame = `<g fill="none" stroke="${GOLD}"><rect x="330" y="360" width="2340" height="1420" rx="40" stroke-width="10"/><rect x="370" y="400" width="2260" height="1340" rx="28" stroke-width="4"/></g>`;
  const stars = (pts) => `<g fill="${GOLD}">${pts.map(p => star(...p)).join('')}</g>`;
  // front: name fitted to the free width
  const art = o.art ? 1 : 0, boxW = art ? 1250 : 2000, left = art ? 1300 : 500;
  let size = font === 'script' ? 620 : 480, [nd, nw] = caseText(G[font], name, size); if (nw > boxW) { size = size * boxW / nw; [nd, nw] = caseText(G[font], name, size); }
  const sh = font === 'name' ? size * 0.045 : 0, ny = 1070 + size * (font === 'script' ? 0.3 : 0.36); // Playful gets a gold drop shadow
  const front = `<g>${frame}${stars([[520, 560, 46], [2480, 560, 34], [2480, 1580, 46], [520, 1580, 30]])}`
    + (art ? `<image href="${o.art}" xlink:href="${o.art}" x="430" y="460" width="900" height="1220" preserveAspectRatio="xMidYMid meet"/>` : '')
    + (sh ? `<g fill="${GOLD}" transform="translate(${left + (boxW - nw) / 2 + sh} ${ny + sh})">${nd}</g>` : '')
    + `<g fill="${ink}" transform="translate(${left + (boxW - nw) / 2} ${ny})">${nd}</g></g>`;
  // back: quote on up to two lines, small monogram underneath
  const words = quote.split(' '), qs = 230; let lines = [quote];
  if (caseText(G.quote, quote, qs)[1] > 1900) { let best = 1, diff = 1e9; for (let i = 1; i < words.length; i++) { const a = caseText(G.quote, words.slice(0, i).join(' '), qs)[1], b = caseText(G.quote, words.slice(i).join(' '), qs)[1], d = Math.abs(a - b) - (words[i - 1].endsWith(',') ? 3000 : 0); if (d < diff) { diff = d; best = i; } } lines = [words.slice(0, best).join(' '), words.slice(best).join(' ')]; }
  const top = 1040 - (lines.length - 1) * 150;
  const qtext = lines.map((l, i) => { const [d, w] = caseText(G.quote, l, qs); return `<g transform="translate(${(W - w) / 2} ${top + i * 300})">${d}</g>`; }).join('');
  const [md, mw] = caseText(G.quote, 'M', 120);
  const back = `<g>${frame}${stars([[520, 560, 34], [2480, 1580, 34]])}<g fill="${ink}">${qtext}</g>`
    + `<circle cx="1500" cy="1500" r="88" fill="none" stroke="${GOLD}" stroke-width="6"/><g fill="${GOLD}" transform="translate(${1500 - mw / 2} 1542)">${md}</g></g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 3000 3900" width="3000" height="3900">`
    + `<rect width="3000" height="3900" fill="${bg}"/>${front}<g transform="rotate(180 1500 2925) translate(0 1950)">${back}</g></svg>`;
}
let CASE_G = null; // glyph outlines, stored in KV as raw:case-glyphs-0..2 (from worker/tools/glyphs.min.json)
const caseG = async (env) => CASE_G || (CASE_G = await (async () => { const g = JSON.parse((await Promise.all([0, 1, 2].map(k => env.BOOKS.get('raw:case-glyphs-' + k)))).join('')); g.script = JSON.parse((await env.BOOKS.get('raw:case-glyphs-script-0')) + (await env.BOOKS.get('raw:case-glyphs-script-1'))); g.story = JSON.parse(await env.BOOKS.get('raw:case-glyphs-story')); return g; })());
async function caseArt(env, id) { // print file for one order line: name/quote/colour stored by printifyOrder; casep adds the child's cartoon (background removed)
  const o = JSON.parse(await env.BOOKS.get('case:' + id) || 'null'); if (!o) return null;
  let art = '';
  if (o.cover) { const s = await env.BOOKS.get('clean:' + o.cover, 'stream'); if (s) art = 'data:image/png;base64,' + b64(await (await env.IMAGES.input(s).transform({ width: 1000, segment: 'foreground' }).output({ format: 'image/png' })).response().arrayBuffer()); }
  const G = await caseG(env);
  return new Response(caseSVG(G, { name: o.name, quote: G.quotes.indexOf(o.quote), colour: (o.colour || '').toLowerCase(), font: o.font, art }), { headers: { 'content-type': 'image/svg+xml' } });
}
// Lifestyle photos for the wearables: a whole family (kids and a toddler too) in the matching personalised piece.
// Same pattern as life(): each key/scene is generated once from the real design and cached in KV as wear:<key>-<n>.
const CDN = 'https://cdn.shopify.com/s/files/1/1003/5766/9231/files/';
const WEAR = {
  tee: { g: 'crew-neck T-shirts', c: ['red', 'white', 'heather grey'] },
  sweatshirt: { g: 'crewneck sweatshirts', c: ['forest green', 'navy', 'red'] },
  hoodie: { g: 'pullover hoodies', c: ['heather grey', 'black', 'red'] },
  sweater: { aop: ['aop-classic-knitted.jpg', 'aop-evergreen-knitted.jpg', 'aop-plaingreen-knitted.jpg'], g: 'ugly Christmas sweaters (crewneck sweatshirts printed all over with this knit design)' },
  uglyhoodie: { aop: ['aop-navy-knitted.jpg', 'aop-candy-knitted.jpg', 'aop-classic-knitted.jpg'], g: 'ugly Christmas hoodies (pullover HOODIES with hoods and a kangaroo pocket, printed all over with this knit design; not sweaters)' },
};
const WEAR_SCENES = [
  'standing together in front of a twinkling Christmas tree in a cosy living room, laughing with their arms around each other, the family dog sitting at their feet',
  'snuggled on the sofa on Christmas morning opening presents, wrapping paper everywhere, genuine delighted reactions, the toddler on mum\'s lap',
  'on a snowy front porch strung with warm Christmas lights, the toddler on dad\'s hip, everyone smiling at the camera as soft snow falls'];
async function wear(env, name, ctx) {
  const m = /^([a-z]+)-([0-2])\.jpg$/.exec(name), w = m && WEAR[m[1]]; if (!w) return new Response('not found', { status: 404 });
  const key = 'wear:' + m[1] + '-' + m[2], hit = await env.BOOKS.get(key, 'arrayBuffer');
  const ok = (v) => new Response(v, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400' } });
  if (hit) return ok(hit);
  if (await env.BOOKS.get('lock:' + key)) return new Response('busy, retry in a minute', { status: 503, headers: { 'retry-after': '60' } });
  await env.BOOKS.put('lock:' + key, '1', { expirationTtl: 180 });
  const n = +m[2], fam = FAMILIES[(m[1].length * 3 + n * 2) % FAMILIES.length];
  const ref = w.aop ? await (await fetch(CDN + w.aop[n])).arrayBuffer() : await env.BOOKS.get('clean:sample', 'arrayBuffer');
  const what = w.aop ? `matching ${w.g}; image 1 is a sample knitted front panel, so every garment has the same knit pattern and colours as image 1, but the knitted cartoon family on the chest shows THIS family (the same people, with their own skin tones, hair and faces), knitted in the same style, straight into the knit with no patch, box, panel, frame or border around them; knit their faces and hair in their real skin and hair colours even where the rest of the knit uses other colours`
    : `matching ${w.c[n]} ${w.g}, each printed on the chest with a cartoon of THIS family (the same people, with their own skin tones, hair and faces) drawn in exactly the cartoon style of image 1 (same bold outlines, colours and festive scene; a little smaller on the children). The cartoon is printed straight onto the fabric as a cut-out shape: NO box, rectangle, panel, frame, border or background behind it, so the garment's own colour shows all around and between the figures. Keep the print a realistic size: ${m[1] === 'hoodie' ? 'about a third of the chest width, centred on the upper chest and entirely above the front pocket' : 'a big front print about half the width of the chest, centred on the chest'}`;
  const prompt = `Image 1 is the personalised design from our shop. Make a warm, candid lifestyle photograph for an online clothing shop: ${fam} of exactly four people (a mum, a dad, a child about 7 and a toddler about 2) ${WEAR_SCENES[n]}. Every person looks clearly different from the others: different faces, ages, hair and builds; no twins, no repeated or duplicated faces. EVERYONE, including both children, wears ${what}. The people in the photo are real people, not the cartoon. Real, natural faces with genuine joy, soft golden light, shallow depth of field, shot on a full-frame camera, photorealistic. No other text, no logos, no watermark.`;
  // run the generation under waitUntil so it still finishes and caches if the requester gives up waiting
  const job = (async () => {
    const img = await gemini(env, prompt, [{ mime: 'image/jpeg', data: b64(ref) }], '4:5', '2K');
    const jpg = await (await env.IMAGES.input(toStream(img)).transform({ width: 2000 }).output({ format: 'image/jpeg', quality: 88 })).response().arrayBuffer();
    await env.BOOKS.put(key, jpg); return jpg;
  })();
  if (ctx) ctx.waitUntil(job.catch(() => env.BOOKS.delete('lock:' + key)));
  try { return ok(await job); }
  catch (e) { await env.BOOKS.delete('lock:' + key); return new Response('failed: ' + e.message, { status: 502 }); }
}
// Plain white garments, cut out (PNG with alpha), for the live mockup on apparel pages: the page tints them to the chosen colour
// and lays the customer's design on the chest. Generated once and cached in KV, same pattern as wear().
const BLANK = { tee: 'short-sleeve crew-neck T-shirt', sweatshirt: 'crewneck sweatshirt with ribbed cuffs and waistband', hoodie: 'pullover hoodie with the hood down and a kangaroo pocket' };
async function blank(env, name, ctx) {
  const m = /^([a-z]+)\.png$/.exec(name), g = m && BLANK[m[1]]; if (!g) return new Response('not found', { status: 404 });
  const key = 'blank:' + m[1], hit = await env.BOOKS.get(key, 'arrayBuffer');
  const ok = (v) => new Response(v, { headers: { ...CORS, 'content-type': 'image/png', 'cache-control': 'public, max-age=604800' } });
  if (hit) return ok(hit);
  if (await env.BOOKS.get('lock:' + key)) return new Response('busy, retry in a minute', { status: 503, headers: { 'retry-after': '60' } });
  await env.BOOKS.put('lock:' + key, '1', { expirationTtl: 180 });
  const prompt = `Studio product photo of ONE plain, completely blank, bright white ${g}, front view, laid perfectly flat and symmetrical, sleeves straight out to the sides, centred and filling most of the frame. No print, no logo, no label, no text, no hanger, no model. Soft even light with gentle natural fabric folds and stitching visible. Plain light grey background.`;
  const job = (async () => {
    const img = await gemini(env, prompt, [], '1:1', '2K');
    const png = await (await env.IMAGES.input(toStream(img)).transform({ width: 1200, segment: 'foreground' }).output({ format: 'image/png' })).response().arrayBuffer();
    await env.BOOKS.put(key, png); return png;
  })();
  if (ctx) ctx.waitUntil(job.catch(() => env.BOOKS.delete('lock:' + key)));
  try { return ok(await job); }
  catch (e) { await env.BOOKS.delete('lock:' + key); return new Response('failed: ' + e.message, { status: 502 }); }
}
// Ornament lifestyle photos (/orn/<n>.jpg) and the homepage banner (/banner/<n>.jpg): generated once from our real product
// images and cached in KV, same pattern as wear().
const ORN = [
  ['pet_cat.png', 'hanging on a lush, warmly lit Christmas tree at eye level, the same cat from the ornament curled up on a knitted blanket under the tree among wrapped gifts, a toddler in Christmas pyjamas sitting beside the cat and gently stroking it'],
  ['pet_cat.png', 'close-up hanging from a fir branch, a girl about 6 gently touching it with her mum crouched beside her, their cat sitting at their feet looking up at the tree, twinkling fairy-light bokeh'],
  ['pet_cat.png', 'hanging on the tree next to glass baubles and red ribbon, a child kneeling and pointing at it while the family cat rubs against her legs'],
  ['pet_dog.png', 'hanging front and centre on a decorated Christmas tree, the same dog from the ornament sitting proudly beside the tree wearing a red scarf, a boy about 7 hugging the dog and grinning at the ornament'],
  ['memorial_lab.png', 'hanging on a Christmas tree, a mother and her daughter about 9 looking at it together with gentle smiles, a softly glowing candle on the mantel, warm and comforting mood'],
  ['first_pup.png', 'being hung on the tree by a smiling young family, dad lifting their toddler up to hang it, the same puppy from the ornament sniffing a gift box at their feet'],
  ['friends_ornament.png', 'hanging on a Christmas tree at a cosy friends\' party, four friends with mugs of cocoa laughing in the soft-focus background'],
];
const BANNER_REFS = ['aop-classic-knitted.jpg', 'mug_dog_mom.png', 'pet_dog.png'];
const BANNER = [
  'a family of four (two parents, a girl about 7, a toddler about 2)',
  'a family of four (two dads, a boy about 8, a toddler girl about 2)',
  'a multigenerational family (grandparents, two parents, a girl about 6 and a toddler boy about 2)',
];
async function cached(env, key, make) {
  const hit = await env.BOOKS.get(key, 'arrayBuffer'), ok = (v) => new Response(v, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400' } });
  if (hit) return ok(hit);
  if (await env.BOOKS.get('lock:' + key)) return new Response('busy, retry in a minute', { status: 503, headers: { 'retry-after': '60' } });
  await env.BOOKS.put('lock:' + key, '1', { expirationTtl: 180 });
  try { const jpg = await make(); await env.BOOKS.put(key, jpg); return ok(jpg); }
  catch (e) { await env.BOOKS.delete('lock:' + key); return new Response('failed: ' + e.message, { status: 502 }); }
}
const refImg = async (f) => { const r = await fetch(CDN + f); return { mime: r.headers.get('content-type') || 'image/png', data: b64(await r.arrayBuffer()) }; };
const toJpg = async (env, img, width) => (await env.IMAGES.input(toStream(img)).transform({ width }).output({ format: 'image/jpeg', quality: 88 })).response().arrayBuffer();
async function orn(env, name) {
  const m = /^([0-9])\.jpg$/.exec(name), o = m && ORN[+m[1]]; if (!o) return new Response('not found', { status: 404 });
  return cached(env, 'orn:' + m[1], async () => {
    const prompt = `Image 1 is a personalised Christmas ornament from our shop. Make a warm, candid lifestyle photograph for an online gift shop: this exact ornament ${o[1]}. The ornament must look exactly like image 1 (same shape, photo, name and lettering, clearly readable) at a realistic size (about 8 cm / 3 inches across, no bigger than the other baubles), hanging from a branch by its string, sharply in focus. Cosy home, soft golden light, shallow depth of field, shot on a full-frame camera, photorealistic. No other text, no logos, no watermark.`;
    return toJpg(env, await gemini(env, prompt, [await refImg(o[0])], '4:5', '2K'), 2000);
  });
}
const SOCK_PETS = { dog: 'pet_dog.png', cat: 'pet_cat.png' };
const SOCK = [ // [pet, scene]
  ['dog', 'a pair of these socks laid flat side by side on a white knitted blanket, top-down product photo, a candy cane and a sprig of holly beside them'],
  ['dog', 'worn by a woman curled up on a cosy sofa by a lit Christmas tree, only her legs and feet in the socks visible in the foreground, the same dog from the socks asleep beside her feet'],
  ['cat', 'a pair of these socks laid flat side by side on a white knitted blanket, top-down product photo, a small wrapped gift with red ribbon beside them'],
  ['cat', 'peeking out of the top of a red Christmas stocking hung on a fireplace mantel, warm fairy lights, the same cat from the socks sitting on the hearth below'],
];
async function sockTile(env, pet) { // demo pattern made from our sample pet photos, kept in KV
  const key = 'socktile:' + pet, hit = await env.BOOKS.get(key, 'arrayBuffer'); if (hit) return hit;
  const img = await gemini(env, PROMPTS.socks({}), [await refImg(SOCK_PETS[pet])], '1:1', '2K');
  const jpg = await toJpg(env, img, 1600); await env.BOOKS.put(key, jpg); return jpg;
}
async function sock(env, name) { // /sock/<0..3>.jpg lifestyle photos, /sock/tile-<dog|cat>.jpg the demo patterns
  const t = /^tile-(dog|cat)\.jpg$/.exec(name); if (t) return cached(env, 'socktilepub:' + t[1], () => sockTile(env, t[1]));
  const m = /^([0-3])\.jpg$/.exec(name), o = m && SOCK[+m[1]]; if (!o) return new Response('not found', { status: 404 });
  return cached(env, 'sock:' + m[1], async () => {
    const tile = await sockTile(env, o[0]);
    const prompt = `Image 1 is the print pattern of our personalised crew socks. Make a warm, candid lifestyle photograph for an online gift shop: a pair of mid-calf crew socks printed all over with exactly this pattern (same pet faces, Santa hats, cream background and red and green motifs, repeated down the whole sock), ${o[1]}. Realistic sock shape with ribbed cuffs, heel and toe in the same print, the pattern clearly visible and sharply in focus. Christmas home, soft golden light, photorealistic. No text, no logos, no watermark.`;
    return toJpg(env, await gemini(env, prompt, [{ mime: 'image/jpeg', data: b64(tile) }], '4:5', '2K'), 2000);
  });
}
async function banner(env, name) {
  const m = /^([0-2])\.jpg$/.exec(name); if (!m) return new Response('not found', { status: 404 });
  return cached(env, 'banner:' + m[1], async () => {
    const prompt = `Three products from our shop: image 1 is a personalised ugly Christmas sweater design (a knitted panel with a cartoon family on the chest), image 2 is our Best Dog Mom mug, image 3 is our personalised pet photo ornament. Make a wide, warm lifestyle photograph for a website homepage banner: ${BANNER[+m[1]]} and their golden retriever in a cosy living room on Christmas morning, laughing together. EVERYONE wears matching ugly Christmas sweaters with the same knit pattern and colours as image 1, and the knitted cartoon family on the chest shows THIS family (the same people, with their own skin tones, hair and faces), knitted in the same style as image 1. Mum holds the mug from image 2 with its design facing the camera. The ornament from image 3 hangs from a branch of the decorated Christmas tree behind them by its string, at a realistic size (about 8 cm / 3 inches, the same size as the other baubles, never floating or oversized), sharp enough to see its photo and name. Count the people: exactly the people described, all clearly visible, nobody missing; the children sit in front, fully in frame. Put the family and tree on the right two thirds; keep the left third softer and less busy (window light, blurred room) so headline text can sit there. The people are real people, not cartoons, with genuine joy. Soft golden light, shot on a full-frame camera, photorealistic. No text, no logos, no watermark.`;
    return toJpg(env, await gemini(env, prompt, await Promise.all(BANNER_REFS.map(refImg)), '21:9', '2K'), 2400);
  });
}
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'content-type': 'application/json' } });

// ---------- Lulu ----------
async function lulu(env, method, path, body, sandbox) {
  const host = sandbox ? 'https://api.sandbox.lulu.com' : 'https://api.lulu.com';
  const t = await fetch(host + '/auth/realms/glasstree/protocol/openid-connect/token', { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + btoa((env.LULU_CLIENT_KEY || env.LULU_KEY) + ':' + (env.LULU_CLIENT_SECRET || env.LULU_SECRET)) },
    body: 'grant_type=client_credentials' });
  if (!t.ok) return { status: t.status, body: 'auth failed: ' + (await t.text()).slice(0, 300) };
  const { access_token } = await t.json();
  const r = await fetch(host + path, { method, headers: { authorization: 'Bearer ' + access_token, 'content-type': 'application/json', 'cache-control': 'no-cache' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.text() };
}
const POD = { 50: '0850X1100BWSTDPB060UW444MXX' };

// ---------- Printify (apparel) ----------
// SKU PFY-<blueprint>-<provider>-<variant>-<kind>[-<pattern>]; flat = scene as is, cut = scene with background removed (any colour),
// aop = all-over print: front from the 'sweater'/'sweater_cutout' preview, other panels plain knit in <pattern>.
// Print files are served from /art/<kind>/<id>/<sig>.jpg (signed, so only Printify gets the clean art).
const artUrl = async (env, kind, id) => `https://dl.merrykin.com/art/${kind}/${id}/${await sigFor(env, 'art-' + kind, id, '', '')}.${kind === 'cut' ? 'png' : kind === 'case' ? 'svg' : 'jpg'}`;
const PATTERNS = ['evergreen', 'navy', 'candy', 'plainred', 'plaingreen', 'plainnavy'], pat = (p) => PATTERNS.includes(p) ? '-' + p : ''; // knit colourways: raw:knit[-p] (print) and raw:knit-ref[-p] (Gemini reference)
// [y, scale] per blueprint, scale = share of the print-area width. Tees/sweatshirts: a big full-front print (areas are taller than wide).
// Hoodie areas stop above the pocket (adult 3531x2352, youth 3000x2400), so the square cartoon fills their height instead.
const FIT = { 77: [0.5, 0.66], 314: [0.5, 0.8] }, FIT_DEFAULT = [0.42, 0.95];
const AOP_AREAS = { 1917: ['back', 'left_sleeve', 'right_sleeve'], 450: ['back', 'right_sleeve', 'left_sleeve', 'pocket', 'waistband', 'right_hood', 'left_hood', 'right_cuff_panel', 'left_cuff_panel'] }; // filled with the plain knit
async function art(env, kind, id) {
  const scene = () => env.BOOKS.get('clean:' + id, 'stream'), knit = (p) => env.BOOKS.get('raw:knit' + pat(p), 'stream');
  const out = (t) => t.output({ format: 'image/jpeg', quality: 90 }).then(r => r.response());
  if (kind === 'case') return caseArt(env, id);
  if (kind === 'socks') { // the square pet tile, repeated down a full leg panel (Printify 376: 1348 x up to 5657 per leg)
    const t = await env.BOOKS.get('clean:' + id, 'arrayBuffer'); if (!t) return null;
    const tile = () => env.IMAGES.input(toStream(t)).transform({ width: 1348, height: 1348, fit: 'cover' });
    return out(env.IMAGES.input(toStream(t)).transform({ width: 1348, height: 5657, fit: 'cover' }).draw(tile(), { repeat: 'y', top: 0, left: 0 }));
  }
  if (kind === 'flat') { const s = await scene(); return s ? new Response(s, { headers: { 'content-type': 'image/jpeg' } }) : null; }
  const panel = (src) => out(env.IMAGES.input(src).transform({ width: 5037, height: 6600, fit: 'cover' }));
  if (kind.startsWith('knit')) return panel(await knit(kind.slice(5)));
  if (kind === 'cut') { const s = await scene(); return s ? env.IMAGES.input(s).transform({ segment: 'foreground' }).output({ format: 'image/png' }).then(r => r.response()) : null; } // transparent background for coloured garments                    // back and sleeves
  const s = await scene(); return s ? panel(s) : null;               // aop front: the seamless knitted design from the 'sweater' preview
}
async function printifyOrder(env, o, order) {
  const lines = [];
  for (const l of o.lines || []) {
    const m = /^PFY-(\d+)-(\d+)-(\d+)-(flat|cut|aop|case|casep|socks)(?:-([a-z]+))?$/.exec(l.sku || ''); if (!m || (!l.cover && !/^case/.test(m[4]))) continue;
    let areas;
    if (m[4] === 'aop') { const knit = await artUrl(env, 'knit' + pat(m[5]), l.cover); areas = { front: await artUrl(env, 'aop', l.cover) }; for (const a of AOP_AREAS[m[1]] || []) areas[a] = knit; }
    else if (m[4] === 'socks') { const leg = [{ src: await artUrl(env, 'socks', l.cover), x: 0.5, y: 0.5, scale: 1, angle: 0 }]; areas = { front_left_leg: leg, front_right_leg: leg, back_left_leg: leg, back_right_leg: leg }; }
    else if (/^case/.test(m[4])) { const id = order + '-' + lines.length; await env.BOOKS.put('case:' + id, JSON.stringify({ name: l.name, quote: l.quote, colour: l.colour, font: l.font, cover: m[4] === 'casep' ? l.cover : '' }), { expirationTtl: 400 * DAY }); areas = { front: [{ src: await artUrl(env, 'case', id), x: 0.5, y: 0.5, scale: 1, angle: 0 }] }; }
    // hoodie print areas are short and wide (they stop above the pocket), so the square cartoon is sized to the area's height there
    else { const [y, scale] = FIT[+m[1]] || FIT_DEFAULT; areas = { front: [{ src: await artUrl(env, m[4], l.cover), x: 0.5, y, scale, angle: 0 }] }; }
    lines.push({ blueprint_id: +m[1], print_provider_id: +m[2], variant_id: +m[3], quantity: l.qty || 1, print_areas: areas });
  }
  if (!lines.length || await env.BOOKS.get('pjob:' + order)) return;
  const s = o.shipping || {}, [first, ...rest] = (s.name || 'Customer').split(' ');
  const shop = env.PRINTIFY_SHOP || '29508447', H = { authorization: 'Bearer ' + (env.PRINTIFY_TOKEN || env.PRINTIFY_KEY), 'content-type': 'application/json', 'user-agent': 'merrykin' };
  const r = await fetch(`https://api.printify.com/v1/shops/${shop}/orders.json`, { method: 'POST', headers: H, body: JSON.stringify({
    external_id: order, label: order, line_items: lines, shipping_method: 1, send_shipping_notification: false,
    address_to: { first_name: first, last_name: rest.join(' ') || '-', email: o.email, phone: s.phone || '', country: s.country_code, region: s.province_code || '',
      address1: s.address1, address2: s.address2 || '', city: s.city, zip: s.zip } }) });
  const t = await r.text(); let sent = '';
  if (r.ok && env.PRINTIFY_HOLD !== '1') { const id = JSON.parse(t).id; for (let i = 0; i < 5; i++) { await new Promise(r => setTimeout(r, 5000)); const p = await fetch(`https://api.printify.com/v1/shops/${shop}/orders/${id}/send_to_production.json`, { method: 'POST', headers: H }); sent = p.status + ' ' + (await p.text()).slice(0, 300); if (p.ok) break; } } // Printify rejects this until its cost calculation finishes (~10 s)
  await env.BOOKS.put('pjob:' + order, JSON.stringify({ at: Date.now(), status: r.status, body: t.slice(0, 2000), sent }), { expirationTtl: 400 * DAY });
  if (r.ok && o.gid) await track(env, order, { gid: o.gid, printify: JSON.parse(t).id });
}

// ---------- Tracking -> Shopify ----------
// Lulu and Printify don't report back to Shopify, so the cron (every 3rd hourly run) polls them and marks the matching order lines fulfilled
// with tracking (Shopify then emails the customer). Needs SHOPIFY_TOKEN (custom app: read/write orders + merchant-managed fulfillment).
async function track(env, order, add) { const k = 'track:' + order, o = JSON.parse(await env.BOOKS.get(k) || '{}'); await env.BOOKS.put(k, JSON.stringify({ ...o, ...add }), { expirationTtl: 120 * DAY }); }
// Dev Dashboard apps have no permanent token: exchange SHOPIFY_CLIENT_ID/SECRET for a 24 h token (client credentials grant), cached in KV
const hasShop = (env) => !!(env.SHOPIFY_TOKEN || (env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET));
async function shopToken(env) {
  if (env.SHOPIFY_TOKEN) return env.SHOPIFY_TOKEN;
  const c = await env.BOOKS.get('shoptoken'); if (c) return c;
  const r = await fetch(`https://${env.SHOPIFY_SHOP || 'fyx6d1-wt.myshopify.com'}/admin/oauth/access_token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.SHOPIFY_CLIENT_ID, client_secret: env.SHOPIFY_CLIENT_SECRET }) });
  if (!r.ok) throw new Error('shop token ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const { access_token, expires_in } = await r.json();
  await env.BOOKS.put('shoptoken', access_token, { expirationTtl: Math.max(60, (expires_in || 86399) - 3600) });
  return access_token;
}
async function shopifyGql(env, query, variables) {
  const r = await fetch(`https://${env.SHOPIFY_SHOP || 'fyx6d1-wt.myshopify.com'}/admin/api/2025-10/graphql.json`, { method: 'POST',
    headers: { 'x-shopify-access-token': await shopToken(env), 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  return r.json();
}
async function fulfil(env, gid, skuRe, t) { // t: {number, url, company}
  const q = await shopifyGql(env, `query($id:ID!){order(id:$id){fulfillmentOrders(first:20){nodes{id status lineItems(first:50){nodes{id remainingQuantity sku}}}}}}`, { id: gid });
  const fos = (q.data?.order?.fulfillmentOrders?.nodes || []).filter(f => /OPEN|IN_PROGRESS/.test(f.status))
    .map(f => ({ fulfillmentOrderId: f.id, fulfillmentOrderLineItems: f.lineItems.nodes.filter(l => l.remainingQuantity > 0 && skuRe.test(l.sku || '')).map(l => ({ id: l.id, quantity: l.remainingQuantity })) }))
    .filter(f => f.fulfillmentOrderLineItems.length);
  if (!fos.length) return 'nothing open';
  const r = await shopifyGql(env, `mutation($f:FulfillmentInput!){fulfillmentCreate(fulfillment:$f){fulfillment{id} userErrors{message}}}`,
    { f: t ? { lineItemsByFulfillmentOrder: fos, notifyCustomer: true, trackingInfo: { number: t.number, url: t.url, company: t.company } } : { lineItemsByFulfillmentOrder: fos, notifyCustomer: false } }); // t = null: digital, no tracking, no shipping email
  return JSON.stringify(r.data?.fulfillmentCreate?.userErrors || r.errors || 'ok');
}
async function syncTracking(env) {
  if (!hasShop(env)) return 'no Shopify credentials';
  const log = [];
  for (const { name } of (await env.BOOKS.list({ prefix: 'track:' })).keys) {
    const o = JSON.parse(await env.BOOKS.get(name) || '{}'), order = name.slice(6);
    try {
      if (o.lulu && !o.luluDone) {
        const j = JSON.parse((await lulu(env, 'GET', `/print-jobs/${o.lulu}/`, null, env.LULU_SANDBOX === '1')).body || '{}');
        const li = (j.line_items || []).find(l => l.tracking_id);
        if (li) { log.push(order + ' lulu ' + await fulfil(env, o.gid, /^WCB-PRT-/, { number: li.tracking_id, url: (li.tracking_urls || [])[0], company: li.carrier_name })); o.luluDone = 1; }
      }
      if (o.printify && !o.printifyDone) {
        const r = await fetch(`https://api.printify.com/v1/shops/${env.PRINTIFY_SHOP || '29508447'}/orders/${o.printify}.json`, { headers: { authorization: 'Bearer ' + (env.PRINTIFY_TOKEN || env.PRINTIFY_KEY), 'user-agent': 'merrykin' } });
        const sh = ((await r.json()).shipments || []).find(s => s.number);
        if (sh) { log.push(order + ' printify ' + await fulfil(env, o.gid, /^PFY-/, { number: sh.number, url: sh.url, company: sh.carrier })); o.printifyDone = 1; }
      }
    } catch (e) { log.push(order + ' error ' + e.message); }
    if ((!o.lulu || o.luluDone) && (!o.printify || o.printifyDone)) await env.BOOKS.delete(name); else await env.BOOKS.put(name, JSON.stringify(o), { expirationTtl: 120 * DAY });
  }
  await env.BOOKS.put('track:last', JSON.stringify({ at: new Date().toISOString(), log }).slice(0, 5000));
  return log;
}

// Shopify Flow "Send HTTP request" posts: {order, email, shipping:{...}, express, lines:[{sku, qty, name, cover}]}
async function orderHook(req, env) {
  if (req.headers.get('x-hook') !== env.HOOK_SECRET) return new Response('no', { status: 403 });
  const o = await req.json(); const order = String(o.order).replace('#', '');
  if (await env.BOOKS.get('job:' + order)) return json({ ok: true, dup: true });
  const items = [];
  for (const l of o.lines || []) {
    const m = /^WCB-PRT-(.+)$/.exec(l.sku || ''); if (!m) continue;          // printed books only
    const key = m[1].replace(/-C$/, ''), name = (l.name || '').trim().slice(0, 40), cover = l.cover || '';
    const ik = 'print-' + key, ck = 'wrap-' + key;
    const iu = `https://dl.merrykin.com/d/${ik}/${order}/${await sigFor(env, ik, order, name, '')}?n=${encodeURIComponent(name)}`;
    const cu = `https://dl.merrykin.com/d/${ck}/${order}/${await sigFor(env, ck, order, '', cover)}${cover ? '?c=' + cover : ''}`;
    items.push({ external_id: `${order}-${key}`, title: key, pod_package_id: POD[50], quantity: l.qty || 1, printable_normalization: { interior: { source_url: iu }, cover: { source_url: cu } } });
  }
  if (!items.length) return json({ ok: true, none: true });
  const s = o.shipping || {};
  const job = { external_id: order, contact_email: env.CONTACT_EMAIL || 'hello@merrykin.com',
    shipping_level: o.express ? 'EXPRESS' : 'MAIL', line_items: items,
    shipping_address: { name: s.name, street1: s.address1, street2: s.address2 || undefined, city: s.city, state_code: s.province_code,
      country_code: s.country_code, postcode: s.zip, phone_number: s.phone || '0000000000', email: o.email } };
  const r = await lulu(env, 'POST', '/print-jobs/', job, env.LULU_SANDBOX === '1');
  await env.BOOKS.put('job:' + order, JSON.stringify({ at: Date.now(), status: r.status, body: r.body.slice(0, 2000) }), { expirationTtl: 400 * DAY });
  if (r.status < 300 && o.gid) await track(env, order, { gid: o.gid, lulu: JSON.parse(r.body).id });
  return json({ ok: r.status < 300, status: r.status }, r.status < 300 ? 200 : 502);
}

// Shopify admin webhook (Settings > Notifications > Webhooks, "Order payment", JSON). Signed with the key shown on that page,
// stored by the owner as SHOPIFY_WEBHOOK_SECRET. Answers at once (Shopify waits 5 s) and does the Lulu work in the background.
async function shopifyHook(req, env, ctx) {
  const raw = await req.text();
  let ok = false;
  try {
    const k = await crypto.subtle.importKey('raw', enc.encode(env.SHOPIFY_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const mac = Uint8Array.from(atob(req.headers.get('x-shopify-hmac-sha256') || ''), c => c.charCodeAt(0));
    ok = !!env.SHOPIFY_WEBHOOK_SECRET && await crypto.subtle.verify('HMAC', k, mac, enc.encode(raw));
  } catch (e) {}
  if (!ok) return new Response('no', { status: 401 });
  const o = JSON.parse(raw), s = o.shipping_address || {};
  const prop = (l, n) => ((l.properties || []).find(x => x.name === n) || {}).value || '';
  const body = { order: o.name, gid: o.admin_graphql_api_id, email: o.email || o.contact_email, express: (o.shipping_lines || []).some(x => /express/i.test(x.title || '')),
    shipping: { name: s.name, address1: s.address1, address2: s.address2, city: s.city, province_code: s.province_code, country_code: s.country_code, zip: s.zip, phone: s.phone },
    lines: (o.line_items || []).map(l => ({ sku: l.sku, qty: l.quantity, name: prop(l, "Child's name"), cover: prop(l, '_cover') || prop(l, '_art'), quote: prop(l, 'Quote'), colour: prop(l, 'Colour'), font: prop(l, 'Font') })) };
  if (body.gid && hasShop(env) && body.lines.some(l => /^WCB-PDF-/.test(l.sku || ''))) ctx.waitUntil(fulfil(env, body.gid, /^WCB-PDF-/, null)); // PDFs are emailed at payment, so mark them fulfilled right away
  if (o.test) return new Response('test order: nothing printed'); // Shopify Payments test mode never reaches Lulu/Printify
  // the refund policy lets customers cancel within 2 hours, so print jobs wait in KV and the hourly cron releases them
  await env.BOOKS.put('hold:' + String(body.order).replace('#', ''), JSON.stringify({ at: Date.now(), body }), { expirationTtl: 30 * DAY });
  return new Response('ok');
}
async function release(env, body) {
  await printifyOrder(env, body, String(body.order).replace('#', '')); // apparel
  await orderHook(new Request('https://dl.merrykin.com/hook/order', { method: 'POST', headers: { 'x-hook': env.HOOK_SECRET }, body: JSON.stringify(body) }), env); // printed books
}
// Self-service download page (fallback when the confirmation email is slow or lost): /order/1003?email=...
// Shows the same signed links as the email, only when the email matches the order.
const CONFETTI = `<canvas id=c style="position:fixed;inset:0;pointer-events:none;z-index:9"></canvas><div id=t style="position:fixed;left:50%;top:24px;transform:translate(-50%,-140%);transition:transform .6s cubic-bezier(.22,1.3,.36,1);background:#1F5C43;color:#fff;padding:14px 20px;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.2);font-weight:600;z-index:10;text-align:center">🎄 Merry everything! Your book is ready to print.</div><script>(()=>{const t=document.getElementById('t');setTimeout(()=>t.style.transform='translate(-50%,0)',300);setTimeout(()=>t.style.transform='translate(-50%,-140%)',5200);if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;const c=document.getElementById('c'),x=c.getContext('2d'),C=['#1F5C43','#B08D57','#C62E32','#F5F1EA','#2E7D5B'],P=[];const R=()=>{c.width=innerWidth*devicePixelRatio;c.height=innerHeight*devicePixelRatio};R();addEventListener('resize',R);for(let i=0;i<160;i++)P.push({x:Math.random()*c.width,y:-Math.random()*c.height,w:6+Math.random()*8,h:8+Math.random()*10,vx:(Math.random()-.5)*2,vy:2+Math.random()*3,r:Math.random()*6,vr:(Math.random()-.5)*.2,c:C[i%5],s:i%7==0});const end=performance.now()+6000;const f=n=>{x.clearRect(0,0,c.width,c.height);let live=0;for(const p of P){p.x+=p.vx*devicePixelRatio;p.y+=p.vy*devicePixelRatio;p.r+=p.vr;if(p.y<c.height)live++;else if(n<end){p.y=-20;p.x=Math.random()*c.width}x.save();x.translate(p.x,p.y);x.rotate(p.r);x.fillStyle=p.c;if(p.s){x.font=(18*devicePixelRatio)+'px serif';x.fillText('❄',0,0)}else x.fillRect(-p.w/2,-p.h/2,p.w,p.h*Math.abs(Math.cos(p.r)));x.restore()}if(live)requestAnimationFrame(f);else c.remove()};requestAnimationFrame(f)})()</script>`; // celebration on the download page: confetti + holiday toast (skipped with reduced motion)
async function orderLinks(env, num, email) {
  const page = (body) => new Response(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Your Merrykin downloads</title><body style="font:16px/1.5 system-ui;max-width:560px;margin:40px auto;padding:0 16px;color:#1d1d1f"><h2>Your printable books</h2>${body}</body>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  num = num.replace(/\D/g, '');
  const box = 'padding:10px;width:100%;box-sizing:border-box;margin:0 0 10px;font:inherit';
  const form = `<form action="/order"><p>Enter your order number and the email you ordered with:</p><input name=n inputmode=numeric placeholder="Order number, e.g. 1234" value="${num}" required style="${box}"><input name=email type=email placeholder="Email" required style="${box}"><button style="padding:10px 16px;font:inherit">Show my downloads</button></form>`;
  if (!email || !num) return page(form);
  const q = await shopifyGql(env, `query($q:String!){orders(first:1,query:$q){nodes{name email cancelledAt lineItems(first:30){nodes{sku title customAttributes{key value}}}}}}`, { q: 'name:#' + num });
  const o = q.data?.orders?.nodes?.[0];
  if (!o || o.cancelledAt || (o.email || '').toLowerCase() !== email.trim().toLowerCase()) return page('<p>We couldn\'t find that order with that email. Check both, or email hello@merrykin.com.</p>' + form);
  const links = [];
  for (const l of o.lineItems.nodes) {
    if (!/^WCB-PDF-/.test(l.sku || '')) continue;
    const prop = (k) => (l.customAttributes.find(a => a.key === k) || {}).value || '';
    let key = l.sku.replace('WCB-PDF-', ''), cover = '';
    if (key.endsWith('-C')) { key = key.slice(0, -2); cover = prop('_cover'); }
    const name = prop("Child's name").trim().slice(0, 40);
    const u = `https://dl.merrykin.com/d/${key}/${num}/${await sigFor(env, key, num, name, cover)}?n=${encodeURIComponent(name)}${cover ? '&c=' + cover : ''}`;
    links.push(`<p><a href="${esc(u)}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#1F5C43;color:#fff;text-decoration:none;font-weight:bold">Download ${esc(l.title.split(':')[0])}${name ? ' for ' + esc(name) : ''} (PDF)</a></p>`);
  }
  return page(links.length ? links.join('') + '<p style="color:#6e6e73">Print at home as often as you like (US Letter).</p>' + CONFETTI : '<p>This order has no printable PDFs.</p>');
}
async function releaseHeld(env) {
  const log = [];
  for (const { name } of (await env.BOOKS.list({ prefix: 'hold:' })).keys) {
    const h = JSON.parse(await env.BOOKS.get(name) || 'null'); if (!h || Date.now() - h.at < 2 * 3600e3) continue;
    let cancelled = false;
    if (hasShop(env) && h.body.gid) { const q = await shopifyGql(env, `query($id:ID!){order(id:$id){cancelledAt}}`, { id: h.body.gid }); cancelled = !!q.data?.order?.cancelledAt; }
    await env.BOOKS.delete(name);
    if (cancelled) { log.push(name + ' cancelled'); continue; }
    try { await release(env, h.body); log.push(name + ' released'); } catch (e) { log.push(name + ' error ' + e.message); }
  }
  if (log.length) await env.BOOKS.put('hold:last', JSON.stringify({ at: new Date().toISOString(), log }));
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (p[0] === 'd' && p.length === 4)
      return download(env, p[1], p[2], p[3], (url.searchParams.get('n') || '').trim().slice(0, 40), url.searchParams.get('c') || '');
    if (p[0] === 'api' && p[1] === 'preview' && req.method === 'POST') return preview(req, env);
    if (p[0] === 'order') return orderLinks(env, p[1] || url.searchParams.get('n') || '', url.searchParams.get('email') || '');
    if (p[0] === 'bpinfo' && /^\d+$/.test(p[1] || '')) { const r = await fetch(`https://api.printify.com/v1/catalog/blueprints/${p[1]}.json`, { headers: { authorization: 'Bearer ' + (env.PRINTIFY_TOKEN || env.PRINTIFY_KEY), 'user-agent': 'merrykin' } }); const j = await r.json(); return json({ title: j.title, brand: j.brand, model: j.model, description: j.description }); } // public catalog info (size charts)
    if (p[0] === 'opsfix' && p[1] && p[1] === await env.BOOKS.get('opsfix:token')) { // owner tool: one-time KV token; bulk text replacements in product descriptions/SEO from KV opsfix:spec
      await env.BOOKS.delete('opsfix:token');
      const spec = JSON.parse(await env.BOOKS.get('opsfix:spec') || '[]'), log = [];
      for (const it of spec) {
        const q = it.id ? await shopifyGql(env, 'query($id:ID!){product(id:$id){handle descriptionHtml seo{title description}}}', { id: it.id }) : {};
        if (it.fulfilPdf) { log.push([it.fulfilPdf, await fulfil(env, it.fulfilPdf, /^WCB-PDF-/, null)]); continue; }
        const pr = q.data?.product; if (!pr) { log.push([it.id, 'missing']); continue; }
        let d = pr.descriptionHtml, miss = [];
        for (const [x, y] of it.replace || []) { if (!d.includes(x)) { miss.push(x.slice(0, 40)); continue; } d = d.split(x).join(y); }
        const input = { id: it.id }; if (d !== pr.descriptionHtml) input.descriptionHtml = d; if (it.seo) input.seo = it.seo;
        const u = Object.keys(input).length > 1 ? await shopifyGql(env, 'mutation($p:ProductUpdateInput!){productUpdate(product:$p){userErrors{message}}}', { p: input }) : null;
        log.push([pr.handle, d !== pr.descriptionHtml ? 'desc' : '-', it.seo ? 'seo' : '-', miss, u?.data?.productUpdate?.userErrors || u?.errors || null]);
      }
      await env.BOOKS.put('opsfix:log', JSON.stringify(log));
      return json(log);
    }
    if (p[0] === 'pfycat' && /^[\w\/.-]+$/.test(p.slice(1).join('/'))) { const r = await fetch('https://api.printify.com/v1/catalog/' + p.slice(1).join('/'), { headers: { authorization: 'Bearer ' + (env.PRINTIFY_TOKEN || env.PRINTIFY_KEY), 'user-agent': 'merrykin' } }); return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json', ...CORS } }); } // read-only Printify public catalog (blueprints, providers, variants, shipping)
    if (p[0] === 'shopcheck') { try { const q = await shopifyGql(env, '{shop{name} orders(first:1){nodes{name}}}'); return json({ ok: !!q.data?.shop, shop: q.data?.shop?.name, orders: !q.errors, errors: (q.errors || []).map(e => e.message) }); } catch (e) { return json({ ok: false, error: e.message }); } } // connection check, reveals no data
    if (p[0] === 'pvc' && p[1]) { const v = await env.BOOKS.get('wmc:' + p[1], 'arrayBuffer'); return v ? new Response(v, { headers: { ...CORS, 'content-type': 'image/png', 'cache-control': 'private, max-age=3600' } }) : new Response('gone', { status: 404 }); }
    if (p[0] === 'remock' && p[1] && p[1] === await env.BOOKS.get('remock:token')) { // owner tool (one-time KV token): new Printify mockup drafts at the order placement
      await env.BOOKS.delete('remock:token');
      const shop = env.PRINTIFY_SHOP || '29508447', H = { authorization: 'Bearer ' + (env.PRINTIFY_TOKEN || env.PRINTIFY_KEY), 'content-type': 'application/json', 'user-agent': 'merrykin' };
      const up = await (await fetch('https://api.printify.com/v1/uploads/images.json', { method: 'POST', headers: H, body: JSON.stringify({ file_name: 'mk-sample-cut.png', url: await artUrl(env, 'cut', 'sample') }) })).json();
      const MOCKS = { 6: [12100, 12124, 12022, 12142, 11986, 12070], 157: [42519, 38528, 38508, 38533, 38498, 42514], 49: [25458, 25459, 25453, 25462, 25450, 25457], 1256: [94945, 94955, 104036, 104051, 94940, 94950], 77: [32912, 32920, 33387, 33419, 32896, 32904], 603: [71767, 71752, 71760, 71755, 71753], 314: [43917, 43918, 43914, 43919, 43911, 43916] }, out = { upload: up.id || JSON.stringify(up).slice(0, 200) };
      if (up.id) for (const [bp, vids] of Object.entries(MOCKS)) {
        const [y, scale] = FIT[bp] || FIT_DEFAULT;
        const r = await fetch(`https://api.printify.com/v1/shops/${shop}/products.json`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'MK mockup ' + bp + ' (big print)', description: 'mockup only', blueprint_id: +bp, print_provider_id: 99,
          variants: vids.map(id => ({ id, price: 3000, is_enabled: true })), print_areas: [{ variant_ids: vids, placeholders: [{ position: 'front', images: [{ id: up.id, x: 0.5, y, scale, angle: 0 }] }] }] }) });
        const j = await r.json(); out[bp] = j.id ? { id: j.id, imgs: (j.images || []).filter(m => m.position === 'front').map(m => m.src) } : r.status + ' ' + JSON.stringify(j).slice(0, 200);
      }
      await env.BOOKS.put('remock:out', JSON.stringify(out), { expirationTtl: DAY });
      return new Response('done', { status: 404 });
    }
    if (p[0] === 'pship' && p[1]) { // owner tool: Printify shipping (first/additional item, cents) for US and CA, saved to KV pship:<bp>
      const r = await fetch(`https://api.printify.com/v1/catalog/blueprints/${+p[1]}/print_providers/${+(p[2] || 99)}/shipping.json`, { headers: { authorization: 'Bearer ' + (env.PRINTIFY_TOKEN || env.PRINTIFY_KEY) } });
      const j = await r.json(), s = {}; for (const pr of j.profiles || []) for (const c of pr.countries || []) if (c === 'US' || c === 'CA') s[c + ':' + pr.first_item.cost + '/' + pr.additional_items.cost] = (s[c + ':' + pr.first_item.cost + '/' + pr.additional_items.cost] || 0) + pr.variant_ids.length;
      await env.BOOKS.put('pship:' + p[1], JSON.stringify(s), { expirationTtl: DAY }); return new Response('saved', { status: 404 });
    }
    if (p[0] === 'pinfo' && p[1]) { // owner tool: print-area sizes of a Printify blueprint (provider 99) saved to KV pinfo:<bp>
      const r = await fetch(`https://api.printify.com/v1/catalog/blueprints/${+p[1]}/print_providers/${+(p[2] || 99)}/variants.json?show-out-of-stock=1`, { headers: { authorization: 'Bearer ' + (env.PRINTIFY_TOKEN || env.PRINTIFY_KEY) } });
      const j = await r.json(); await env.BOOKS.put('pinfo:' + p[1], JSON.stringify((j.variants || []).map(v => [v.title, (v.placeholders || []).filter(x => x.position === 'front').map(x => [x.width, x.height])[0]])), { expirationTtl: DAY });
      return new Response('saved', { status: 404 });
    }
    if (p[0] === 'thumbcdn' && p[1]) { // owner tool: 420px copy of a store image into KV thumbout:cdn:<file> for review
      const r = await fetch(CDN + p[1]); if (!r.ok) return new Response('no', { status: 404 });
      const t = await (await env.IMAGES.input(r.body).transform({ width: 420 }).output({ format: 'image/jpeg', quality: 70 })).response().arrayBuffer();
      await env.BOOKS.put('thumbout:cdn:' + p[1], t, { expirationTtl: DAY }); return new Response(t, { headers: { 'content-type': 'image/jpeg' } });
    }
    if (p[0] === 'blank' && p[1]) return blank(env, p[1], ctx); // plain garments for the live mockup: /blank/<tee|sweatshirt|hoodie>.png
    if (p[0] === 'pv' && p[1]) {
      const v = await env.BOOKS.get('wm:' + p[1], 'arrayBuffer');
      return v ? new Response(v, { headers: { ...CORS, 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600' } }) : new Response('gone', { status: 404 });
    }
    if (p[0] === 'hook' && p[1] === 'shopify' && req.method === 'POST') return shopifyHook(req, env, ctx);
    if (p[0] === 'hook' && p[1] === 'order' && req.method === 'POST') return orderHook(req, env);
    if (p[0] === 'cover' && p[1]) { // public product images: /cover/<slug>.jpg or /cover/<slug>-20.jpg
      const m = /^([a-z-]+?)(-20)?\.jpg$/.exec(p[1]); const v = m && await env.BOOKS.get((m[2] ? 'raw:cover20:' : 'raw:cover:') + m[1], 'arrayBuffer');
      return v ? new Response(v, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400' } }) : new Response('not found', { status: 404 });
    }
    if (p[0] === 'case' && p[1] === 'preview.svg') { const G = await caseG(env); return new Response(caseSVG(G, { name: url.searchParams.get('n'), quote: G.quotes.indexOf(url.searchParams.get('q')), colour: (url.searchParams.get('c') || '').toLowerCase(), font: url.searchParams.get('f'), art: url.searchParams.get('a') ? 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' : '' }), { headers: { ...CORS, 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=3600' } }); }
    if (p[0] === 'brand' && p[1]) { const v = await env.BOOKS.get('brand:' + p[1], 'arrayBuffer'); return v ? new Response(v, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' } }) : new Response('not found', { status: 404 }); } // brand assets for Shopify uploads: /brand/<file>.png
    if (p[0] === 'sample' && p[1]) return sample(env, p[1]); // free sample PDFs, released on a schedule
    if (p[0] === 'thumb' && p[1] && p[2]) { const v = await env.BOOKS.get(p[1] + ':' + p[2].replace(/\.jpg$/, ''), 'arrayBuffer'); if (!v) return new Response('not found', { status: 404 }); const t = await (await env.IMAGES.input(toStream(v)).transform({ width: 420 }).output({ format: 'image/jpeg', quality: 70 })).response().arrayBuffer(); await env.BOOKS.put('thumbout:' + p[1] + ':' + p[2], t, { expirationTtl: 86400 }); return new Response(t, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-store' } }); } // small review copies of cached photos: /thumb/<prefix>/<key>.jpg
    if (p[0] === 'sock' && p[1]) return sock(env, p[1]); // pet socks: lifestyle photos /sock/<0..3>.jpg, demo tiles /sock/tile-<dog|cat>.jpg
    if (p[0] === 'orn' && p[1]) return orn(env, p[1]); // ornament lifestyle photos: /orn/<0..6>.jpg
    if (p[0] === 'banner' && p[1]) return banner(env, p[1]); // homepage banner: /banner/<0..2>.jpg
    if (p[0] === 'wear' && p[1]) return wear(env, p[1], ctx); // lifestyle photos for apparel: /wear/<tee|sweatshirt|hoodie|sweater|uglyhoodie>-<0..2>.jpg
    if (p[0] === 'peek' && p[1]) { const v = await env.BOOKS.get('peek:' + p[1].replace(/\.jpg$/, ''), 'arrayBuffer'); return v ? new Response(v, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400' } }) : new Response('not found', { status: 404 }); } // watermarked sample pages: /peek/<slug>-<0..2>.jpg
    if (p[0] === 'life' && p[1]) return life(env, p[1]); // lifestyle product photos: /life/<slug>-<0..3>.jpg
    if (p[0] === 'art' && p.length === 4) { // print files for Printify
      const id = p[2], sig = p[3].replace(/\.(jpg|png|svg)$/, '');
      if (sig !== await sigFor(env, 'art-' + p[1], id, '', '')) return new Response('no', { status: 403 });
      return (await art(env, p[1], id)) || new Response('gone', { status: 404 });
    }
    if (p[0] === 'p' && p[1]) { // owner-only test previews (unlisted ids)
      const v = await env.BOOKS.get('prev:' + p[1], 'arrayBuffer');
      return v ? new Response(v, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600' } }) : new Response('gone', { status: 404 });
    }

    if (p[0] === 'admin') {
      if (p[1] === 'page') return new Response(await env.BOOKS.get('page:' + p[2]) || 'none', { headers: { 'content-type': 'text/html; charset=utf-8' } });
      if (req.headers.get('x-admin') !== env.ADMIN) return new Response('no', { status: 403, headers: CORS });
      if (p[1] === 'gen' && req.method === 'POST') { const b = await req.json();
        try { return new Response(await gemini(env, b.prompt, b.images || [], b.aspect || '3:4', b.size || '2K'), { headers: { ...CORS, 'content-type': 'image/png' } }); }
        catch (e) { return json({ error: e.message }, 422); } }
      if (p[1] === 'lulu' && req.method === 'POST') { const b = await req.json(); const r = await lulu(env, b.method || 'GET', b.path, b.body, b.sandbox); return new Response(r.body, { status: r.status, headers: { ...CORS, 'content-type': 'application/json' } }); }
      if (p[1] === 'printify' && req.method === 'POST') { const b = await req.json(); const r = await fetch('https://api.printify.com/v1' + b.path, { method: b.method || 'GET', headers: { authorization: 'Bearer ' + (env.PRINTIFY_TOKEN || env.PRINTIFY_KEY), 'content-type': 'application/json', 'user-agent': 'merrykin' }, body: b.body ? JSON.stringify(b.body) : undefined }); return new Response(await r.text(), { status: r.status, headers: { ...CORS, 'content-type': 'application/json' } }); }
      if (p[1] === 'put' && req.method === 'PUT') { await env.BOOKS.put(p[2], await req.arrayBuffer()); return new Response('ok', { headers: CORS }); }
      if (p[1] === 'get') { const v = await env.BOOKS.get(p[2], 'arrayBuffer'); return v ? new Response(v, { headers: CORS }) : new Response('missing', { status: 404, headers: CORS }); }
      if (p[1] === 'sign') return new Response(await sigFor(env, url.searchParams.get('k'), url.searchParams.get('o'), url.searchParams.get('n') || '', url.searchParams.get('c') || ''), { headers: CORS });
      if (p[1] === 'hook' && req.method === 'POST') return orderHook(new Request(req, { headers: { 'x-hook': env.HOOK_SECRET } }), env);
      return new Response('?', { status: 404, headers: CORS });
    }
    return Response.redirect('https://merrykin.com', 302);
  },
  async scheduled(ev, env, ctx) { ctx.waitUntil(releaseHeld(env).then(() => new Date().getUTCHours() % 3 ? null : syncTracking(env))); },
};
