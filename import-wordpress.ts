// Supabase Edge Function : import-wordpress
// Importe les albums de l'ancien souskay.fr (WordPress) dans albums / album_photos,
// en copiant chaque photo dans le bucket "site". Idempotent : relançable sans doublon.
//
// Appel (depuis /admin/import, utilisateur owner connecté) :
//   POST /functions/v1/import-wordpress   body: { "album_slug": "keloke08", "max": 40 }   → importe jusqu'à 40 photos de l'album
//   POST /functions/v1/import-wordpress   body: { "list": true }               → renvoie la liste et l'état
//
// Source des données : le JSON d'export publié sur GitHub (EXPORT_URL).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const EXPORT_URL =
  "https://raw.githubusercontent.com/lebeneludovic-netizen/souskay-maquette/main/wp-albums-export.json";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Photo = { url: string; thumb: string; w: number | null; h: number | null; source_url: string };
type Album = {
  slug: string; title: string; series_slug: string | null; photographer: string | null;
  taken_at: string; city: string | null; cover_url: string | null; wp_link: string; photos: Photo[];
};

async function copyToBucket(admin: any, src: string, path: string): Promise<string> {
  const res = await fetch(src, { headers: { "User-Agent": UA, Referer: "https://souskay.fr/" } });
  if (!res.ok) throw new Error(`${res.status} sur ${src}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const type = res.headers.get("content-type") ?? "image/jpeg";
  const { error } = await admin.storage.from("site").upload(path, bytes, { contentType: type, upsert: true });
  if (error) throw error;
  return admin.storage.from("site").getPublicUrl(path).data.publicUrl;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

  // 1. seul un owner du CRM peut lancer l'import
  const url = Deno.env.get("SUPABASE_URL")!;
  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: role } = await userClient.rpc("current_role_name");
  if (role !== "owner") return json({ error: "Réservé au rôle owner" }, 403);
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const body = await req.json().catch(() => ({}));
  const exp: { albums: Album[] } = await (await fetch(EXPORT_URL)).json();

  // 2. liste + état d'avancement
  if (body.list) {
    const { data: done } = await admin.from("albums").select("slug, id, album_photos(count)");
    const bySlug = new Map((done ?? []).map((a: any) => [a.slug, a.album_photos?.[0]?.count ?? 0]));
    return json(exp.albums.map((a) => ({
      slug: a.slug, title: a.title, photographer: a.photographer, series: a.series_slug,
      expected: a.photos.length, imported: bySlug.get(a.slug) ?? 0,
    })));
  }

  // 3. import d'un album
  const a = exp.albums.find((x) => x.slug === body.album_slug);
  if (!a) return json({ error: "album inconnu" }, 404);

  let seriesId: string | null = null;
  if (a.series_slug) {
    const { data: s } = await admin.from("site_series").select("id").eq("slug", a.series_slug).maybeSingle();
    seriesId = s?.id ?? null;
  }

  // l'album est créé une seule fois (en brouillon) ; un nouvel appel ne touche plus à ses réglages
  let { data: album } = await admin.from("albums").select("id").eq("slug", a.slug).maybeSingle();
  if (!album) {
    const { data: created, error: e1 } = await admin.from("albums").insert({
      slug: a.slug, title: a.title, series_id: seriesId, photographer: a.photographer,
      taken_at: a.taken_at, city: a.city, kind: "photos", status: "draft", allow_download: true,
    }).select("id").single();
    if (e1) return json({ error: e1.message }, 500);
    album = created;
  }

  const { data: existing } = await admin.from("album_photos").select("source_url").eq("album_id", album.id);
  const already = new Set((existing ?? []).map((p: any) => p.source_url));

  let ok = 0, failed: string[] = [];
  // par lots de 6 en parallèle pour ménager l'ancien serveur
  // on traite au plus `max` photos par appel (limite de durée des edge functions) ; la page d'import rappelle jusqu'à remaining = 0
  const all = a.photos.map((p, i) => ({ p, i })).filter(({ p }) => !already.has(p.source_url));
  const todo = all.slice(0, body.max ?? 40);
  for (let k = 0; k < todo.length; k += 6) {
    await Promise.all(todo.slice(k, k + 6).map(async ({ p, i }) => {
      try {
        const name = p.source_url.split("/").pop()!.replace(/\.[a-z]+$/i, "");
        const big = await copyToBucket(admin, p.url, `albums/${a.slug}/${name}.jpg`);
        const thumb = await copyToBucket(admin, p.thumb, `albums/${a.slug}/thumb/${name}.jpg`);
        await admin.from("album_photos").insert({
          album_id: album.id, url: big, thumb_url: thumb, width: p.w, height: p.h,
          position: i, source_url: p.source_url,
        });
        ok++;
      } catch (e) { failed.push(`${p.source_url} → ${e}`); }
    }));
  }

  // couverture : la photo WordPress mise en avant si on la retrouve, sinon la première
  const { data: first } = await admin.from("album_photos").select("url, source_url")
    .eq("album_id", album.id).order("position").limit(200);
  const cover = first?.find((p: any) => a.cover_url && p.source_url === a.cover_url) ?? first?.[0];
  if (cover) await admin.from("albums").update({ cover_url: cover.url }).eq("id", album.id);

  return json({ slug: a.slug, imported: ok, already: already.size, remaining: all.length - todo.length, failed });
});
