#!/usr/bin/env python3
"""Build content-projects.json by parsing saved fetch results."""
import json
import re
from pathlib import Path

TMP = Path("/Users/jungmok/Google 드라이브/Claude/Business Development/개인 사업 구체화/labflow-app/server/scripts/tmp-projects")
OUT = Path("/Users/jungmok/Google 드라이브/Claude/Business Development/개인 사업 구체화/labflow-app/server/scripts/content-projects.json")
INV = Path("/Users/jungmok/Google 드라이브/Claude/Business Development/개인 사업 구체화/labflow-app/server/scripts/inventory-projects.json")

KEEP_PROPS = ["상태", "담당자", "팀", "관련 과제", "타겟 저널", "유형", "프로젝트명", "우선순위", "완료?", "메모"]

def parse_fetch(raw_text_field):
    """raw_text_field is the 'text' field of a Notion fetch JSON response."""
    text = raw_text_field
    props = {}
    m = re.search(r"<properties>\s*(\{.*?\})\s*</properties>", text, re.DOTALL)
    if m:
        try:
            all_props = json.loads(m.group(1))
            for k in KEEP_PROPS:
                if k in all_props:
                    props[k] = all_props[k]
        except Exception as e:
            props = {"_parse_error": str(e)}
    body = ""
    m = re.search(r"<content>\s*(.*?)\s*</content>", text, re.DOTALL)
    if m:
        body = m.group(1).strip()
    body_length = len(body)
    # Find child page URLs inside body (tags like <page url="https://...">title</page>)
    child_urls = re.findall(r'<page url="(https://www\.notion\.so/[a-f0-9]+)">([^<]*)</page>', body)
    return props, body, body_length, child_urls

def build():
    inv = json.loads(INV.read_text())
    rows = inv["projectRows"]
    result = {"projects": [], "errors": []}
    for row in rows:
        pid = row["id"]
        title = row["title"]
        if "jarvis" in title.lower():
            continue
        # Expected saved file
        f = TMP / f"{pid}.json"
        if not f.exists():
            result["errors"].append({"id": pid, "title": title, "error": "not_fetched"})
            continue
        try:
            raw = json.loads(f.read_text())
            text = raw.get("text", "")
            props, body, body_length, child_urls = parse_fetch(text)
            body_truncated = body[:8000]
            entry = {
                "id": pid,
                "title": title,
                "props": props,
                "body": body_truncated,
                "bodyLength": body_length,
                "childPages": [],
            }
            # Attach child page data if saved
            seen = set()
            for url, ctitle in child_urls:
                # Extract uuid from url
                cid_m = re.search(r"/([a-f0-9]{32})", url)
                if not cid_m:
                    continue
                cid_raw = cid_m.group(1)
                if cid_raw in seen:
                    continue
                seen.add(cid_raw)
                # formatted
                cid = f"{cid_raw[0:8]}-{cid_raw[8:12]}-{cid_raw[12:16]}-{cid_raw[16:20]}-{cid_raw[20:32]}"
                cf = TMP / f"child-{cid_raw}.json"
                if cf.exists():
                    try:
                        craw = json.loads(cf.read_text())
                        ctext = craw.get("text", "")
                        _, cbody, cblen, _ = parse_fetch(ctext)
                        entry["childPages"].append({
                            "id": cid,
                            "title": craw.get("title", ctitle),
                            "body": cbody[:4000],
                            "bodyLength": cblen,
                        })
                    except Exception as e:
                        entry["childPages"].append({"id": cid, "title": ctitle, "error": str(e)})
                else:
                    entry["childPages"].append({"id": cid, "title": ctitle, "note": "child_not_fetched"})
            result["projects"].append(entry)
        except Exception as e:
            result["errors"].append({"id": pid, "title": title, "error": str(e)})
    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(f"Wrote {len(result['projects'])} projects, {len(result['errors'])} errors")

if __name__ == "__main__":
    build()
