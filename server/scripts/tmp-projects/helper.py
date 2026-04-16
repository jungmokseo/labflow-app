#!/usr/bin/env python3
"""Helper to extract project content from Notion fetch results."""
import json
import re
import sys
from pathlib import Path

def extract(raw_json_str, body_limit=8000):
    """Given JSON string from notion-fetch tool, extract key fields."""
    obj = json.loads(raw_json_str) if isinstance(raw_json_str, str) else raw_json_str
    text = obj.get("text", "")
    title = obj.get("title", "")

    # Extract properties block
    props = {}
    m = re.search(r"<properties>\s*(\{.*?\})\s*</properties>", text, re.DOTALL)
    if m:
        try:
            all_props = json.loads(m.group(1))
            keep = ["상태", "담당자", "팀", "관련 과제", "타겟 저널", "유형", "프로젝트명", "우선순위", "완료?", "메모"]
            for k in keep:
                if k in all_props:
                    props[k] = all_props[k]
        except Exception as e:
            props = {"_parse_error": str(e)}

    # Extract body (content block)
    body = ""
    m = re.search(r"<content>\s*(.*?)\s*</content>", text, re.DOTALL)
    if m:
        body = m.group(1).strip()

    body_length = len(body)
    if body_length > body_limit:
        body = body[:body_limit]

    # Extract child_page references (URLs in body that reference pages NOT the parent)
    child_urls = re.findall(r'<page url="(https://www\.notion\.so/[a-f0-9]+)">([^<]*)</page>', body)
    # Also catch inline "notion.so/<hex>" references that appear inside <page> tags
    return {
        "title": title,
        "props": props,
        "body": body,
        "bodyLength": body_length,
        "childPages_raw": child_urls,
    }

if __name__ == "__main__":
    infile = sys.argv[1]
    raw = Path(infile).read_text()
    print(json.dumps(extract(raw), ensure_ascii=False, indent=2))
