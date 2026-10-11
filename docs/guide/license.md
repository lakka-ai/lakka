# Licence and source

Lakka is free software under the GNU Affero General Public License, version 3 (AGPL-3.0-only).
The full text is in `LICENSE`, in the release bundle and the repository.

## The source notice

Every page offers the source. Signed in, it is the first item in the account menu, at the foot of
the side menu (and in the phone menu): "Source code", described by "Lakka is free software under
the AGPL." The setup, sign-in, invite and password reset pages show the same link and sentence in
their footer. This is the offer section 13 of the AGPL requires for people who use the program over
a network.

The link is read when a page is served:

- from `LAKKA_SOURCE_URL`, if you set it (see [Configuration](configuration.md));
- otherwise, the project repository at the exact commit the images were built from;
- otherwise, the project repository.

## If you change the code

If you modify Lakka and let people use your modified version over a network, the AGPL
requires you to offer them the source of **your** version. Publish it, set
`LAKKA_SOURCE_URL` to where it is, and restart:

```
echo 'LAKKA_SOURCE_URL=https://git.example.com/our-lakka' >> .env
docker compose up -d
```

Running an unmodified release needs nothing: the default link already points at the source of
the version you run.

## Third-party components

The images include third-party software under its own licences, all compatible with the AGPL:
Node.js, Postgres with pgvector, Valkey, Caddy, Debian packages, the ONNX runtime and the bundled
embedding models (paraphrase-multilingual-MiniLM-L12-v2 and paraphrase-multilingual-mpnet-base-v2,
both from sentence-transformers, Apache-2.0; each one's license and a NOTICE are in its directory
under `/app/models/` in the image), and the npm packages listed in each image's SBOM, attached to
every release.
