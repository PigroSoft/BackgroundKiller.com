#!/bin/sh
# Builds a zip of the site for self-hosting: dist/background-killer-<version>.zip
# It is a copy of public/ without our visit counter, so your visits are not counted by us.
set -e
cd "$(dirname "$0")/.."
version=$(sed -n "s/^var BK_VERSION = '\(.*\)';/\1/p" public/version.js)
name="background-killer-$version"
out="dist/$name"
rm -rf "dist/$name" "dist/$name.zip"
mkdir -p "$out"
cp -R public/. "$out/"
for f in "$out"/*.html; do
  grep -v 'stats.pigrosoft.com/c.js' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
done
(cd dist && zip -qr "$name.zip" "$name")
rm -rf "$out"
echo "dist/$name.zip"
