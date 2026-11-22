-- Enforce the media whitelist at the storage boundary. The service checks magic bytes before insert, but a future
-- writer (seed, import, migration) must not be able to persist SVG or an arbitrary type that the public route would
-- then serve from this origin.
ALTER TABLE media_assets
  ADD CONSTRAINT media_assets_mime_type_check
  CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp'));
