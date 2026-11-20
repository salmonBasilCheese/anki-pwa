import sqlite3
import sys
import zipfile
from pathlib import Path

BASE = Path(__file__).resolve().parent
DATA = BASE / "data"
OUT = DATA / "extracted"


def find_apkg():
    if len(sys.argv) > 1:
        return Path(sys.argv[1])
    files = sorted(DATA.glob("*.apkg"))
    if len(files) != 1:
        sys.exit(f"Expected exactly one .apkg in {DATA}, found {len(files)}")
    return files[0]


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    apkg = find_apkg()
    print(f"== 1. Extract: {apkg.name}")
    OUT.mkdir(parents=True, exist_ok=True)
    out_root = OUT.resolve()
    with zipfile.ZipFile(apkg, "r") as z:
        for name in z.namelist():
            target = (OUT / name).resolve()
            if out_root not in target.parents and target != out_root:
                sys.exit(f"Unsafe path in archive: {name}")
        z.extractall(OUT)
        media = 0
        for info in z.infolist():
            if info.filename.isdigit():  # numbered media files (0, 1, 2, ...)
                media += 1
                continue
            print(f"  {info.filename}  ({info.file_size} bytes)")
        print(f"  + {media} numbered media files (0..{media - 1})")

    names = {p.name for p in OUT.iterdir()}
    if "collection.anki21b" in names:
        print("\n[WARN] collection.anki21b (zstd-compressed) is present; "
              "collection.anki2 may be only a stub.")
    db_name = next((n for n in ("collection.anki21", "collection.anki2") if n in names), None)
    if not db_name:
        sys.exit("No SQLite collection file found.")
    db_path = OUT / db_name

    con = sqlite3.connect(f"file:{db_path.as_posix()}?mode=ro", uri=True)
    cur = con.cursor()

    print(f"\n== 2. Tables in {db_name}")
    for (t,) in cur.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
        print(f"  {t}")

    print("\n== 3. Counts")
    n_notes = cur.execute("SELECT COUNT(*) FROM notes").fetchone()[0]
    n_cards = cur.execute("SELECT COUNT(*) FROM cards").fetchone()[0]
    print(f"  notes: {n_notes}")
    print(f"  cards: {n_cards}")
    if n_notes == 0:
        print("[WARN] notes is empty; this may be a stub collection.")

    print("\n== 4. First 3 notes")
    for nid, mid, flds in cur.execute("SELECT id, mid, flds FROM notes LIMIT 3"):
        print(f"  note id={nid} mid={mid}")
        for i, f in enumerate(flds.split("\x1f"), 1):
            print(f"    field {i}: {f}")

    print("\n== 5. First 3 cards")
    cols = ["id", "nid", "type", "queue", "due", "ivl", "factor", "reps"]
    print("  " + "".join(f"{c:>16}" for c in cols))
    for row in cur.execute(f"SELECT {', '.join(cols)} FROM cards LIMIT 3"):
        print("  " + "".join(f"{v:>16}" for v in row))

    con.close()


if __name__ == "__main__":
    main()
