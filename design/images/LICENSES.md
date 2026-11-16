# Photo licences

The landing page uses three photographs. The repository records them as Unsplash-licensed (DECISIONS.md L42). The web build stops unless every photo in this folder is named in this file.

**Status: incomplete.** The photographers and the source links are not recorded anywhere in this repository, and the image files carry no author data (no EXIF, XMP or IPTC). Every field marked "to be confirmed by founder" must be filled in by the founder from each photo's Unsplash page. Nothing below has been guessed.

| File               | Used for                                              | Photographer               | Source page                | Licence          |
| ------------------ | ----------------------------------------------------- | -------------------------- | -------------------------- | ---------------- |
| `hero-team.jpg`    | The landing page hero photo, and the Open Graph image | to be confirmed by founder | to be confirmed by founder | Unsplash License |
| `story-ada.jpg`    | Ada, in the landing page story                        | to be confirmed by founder | to be confirmed by founder | Unsplash License |
| `story-kelvin.jpg` | The character Kelvin, in the landing page story       | to be confirmed by founder | to be confirmed by founder | Unsplash License |

Licence terms: https://unsplash.com/license

The founder's brief calls the three photos `p-desk`, `p-founder` and `p-ada`. Those names appear nowhere in the repository, so which file each name means is also to be confirmed by founder.

## Changes made by the build

The original files are never changed. The build (`apps/web/scripts/images.mjs`) crops each photo and writes resized AVIF, WebP and JPEG copies. In `story-ada.jpg` it also blurs the maker's logo on a laptop. The hero photo is cropped to remove a sign, and the Open Graph image is the hero crop under a dark wash with the headline.
