# karevelli.github.io

Portfolio of Karina Belén Revelli, 3D artist.

## Checking links

Build the site and check its internal links:

```
bundle exec jekyll build
bundle exec ruby .github/scripts/check-links.rb _site
```

The check serves the build like GitHub Pages does: a folder without `index.html` is not listed, so a
link to it is reported as broken. It exits with an error when any link is broken.

## License

- Artwork and texts by the artist: see [LICENSE-ARTWORK.md](LICENSE-ARTWORK.md).
- Website source code: see [LICENSE-CODE.md](LICENSE-CODE.md).
