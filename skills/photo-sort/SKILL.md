# photo-sort: Batch Classification and Archiving of Realistic-Style Character Images

Iteratively send images from the folder root to the LLM for inspection, sorting them into 15 category folders.
Cover images featuring cover title text are neither classified nor moved (marked as `SKIP`, keeping the original image in place).
Original images are only "moved" without any modification; previews sent to the LLM are 600x900 q90 JPEGs.

## Categories (15)

男／女／男(中年)／女(中年)／男(老年)／女(老年)／
男孩／女孩／鬼怪(女)／鬼怪(男)／妖獸異獸／動物／機器人／靈體／其他

> **Note**: These 15 category names are literal folder identifiers and must be used verbatim in code, commands, and logic.

## Workflow (3 Steps)

### Step 0: Create Category Folders (Run before starting)

```powershell
'男','女','男(中年)','女(中年)','男(老年)','女(老年)','男孩','女孩',
'鬼怪(女)','鬼怪(男)','妖獸異獸','動物','機器人','靈體','其他' |
  ForEach-Object { New-Item -ItemType Directory -Force -Path $_ | Out-Null }
```

### Step 1: Preprocessing (Convert to 600x900 q90 JPG)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File skills/photo-sort/prep.ps1
```

- Output to `.sort-cache/`, filename = original filename (extension normalized to `.jpg`).
- Center-crop covers to 2:3 ratio then scale, no stretching, portraits remain undistorted.
- Idempotent: previews newer than originals are automatically skipped; outputs `total/done/skip/fail`.
- FAILED list present → inspect those original images individually using `read_image`, do not include in batching.

### Step 2: Batch Inspection + Moving (Core Loop)

1. Use `list_dir` (or glob) to get the list of pending images in the root directory; record total count and progress with `todo_write`.
2. In batches of 6–8, use `read_images` to read corresponding preview images inside `.sort-cache/`.
3. Evaluate each image according to "Decision Rules" to assign a category (including `SKIP`).
   For non-SKIP items, **immediately `move_path` the original image upon completing judgment**
   (original image → corresponding category folder; previews are read, originals are moved—do not confuse them);
   originals judged as `SKIP` remain in the root directory and are not moved.
4. Processed items are not re-read; old images are automatically cleared from the context, which is normal.
5. Filename collision (target already has a file with the same name): rename the original image by appending `_<sequence>` suffix before moving; do not overwrite.
6. Final tally: the sum of file counts across the 15 folders plus `SKIP` retained count in the root directory must equal the original total count.
   If there's a mismatch, track down any missing files. The category column in `moves.csv` can be filled with `SKIP` (uppercase ASCII),
   and `apply-moves.ps1` will skip moving them and tally them in skipped.

## Decision Rules (Applied sequentially, first match wins)

0. **Cover Image Skip (Absolute Priority)**: Images containing cover-style title text
   (major title/book title/author name, poster-style layout, prominent title banners or book cover borders,
   where title text is a primary visual element of the composition) → judge as `SKIP`, do not classify or move.
   Small corner watermarks / signatures / minor explanatory text do not count; classify normally.

1. **Non-human First Check**: Real animals → `動物`; machinery/cyborgs → `機器人`;
   translucent ghosts / energy entities (incorporeal) → `靈體`;
   non-humanoid fantasy creatures / monsters → `妖獸異獸`;
   corporeal humanoid + ghostly traits (horns, fangs, non-human skin tone, shikigami makeup, etc.) → route by gender to
   `鬼怪(女)` / `鬼怪(男)`; if gender is ambiguous, route to `其他` and add a note.
2. **Age**: Children (approx. under 12) → `男孩` / `女孩`;
   obvious aging (white hair, deep wrinkles, approx. 60+) → `男(老年)` / `女(老年)`;
   approx. 40–60, mature feel → `男(中年)` / `女(中年)`;
   remaining adults → `男` / `女`.
3. Multi-character images: Based on the primary subject (largest / centered).
4. None of the above (landscapes, objects, unrecognizable): → `其他`.

## Verification

- Root directory only contains `SKIP` retained images (plus `.sort-cache/`, `skills/`, and category folders), with no other omissions.
- Count of each category + `SKIP` retained count = total from Step 1.
- Spot check 5–10 images to verify no outrageous misclassifications.

## Known Pitfalls

- Local environment lacks Python/Node; image conversion must use PowerShell + System.Drawing.
- `prep.ps1` must remain pure ASCII: Windows PowerShell 5.1 encounters silent parsing errors (empty array, total=0) when processing BOM-less UTF-8 with CJK comments.
  CJK explanations may only appear in English comments outside `.NOTES` or in this file.
- PowerShell execution policy defaults to restricted; all invocations must include `-ExecutionPolicy Bypass`.
- Webp images are not guaranteed to be decodable by GDI+ in this environment; failures will appear in the FAILED list.
