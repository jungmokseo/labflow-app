#!/usr/bin/env python3
"""Read a raw Notion fetch text from stdin or args, parse it, save to tmp dir."""
import sys, json, re
from pathlib import Path

TMP = Path("/Users/jungmok/Google 드라이브/Claude/Business Development/개인 사업 구체화/labflow-app/server/scripts/tmp-projects")
KEEP_PROPS = ["상태", "담당자", "팀", "관련 과제", "타겟 저널", "유형", "프로젝트명", "우선순위", "완료?", "메모"]

def parse(text):
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
    child_urls = re.findall(r'<page url="(https://www\.notion\.so/[a-f0-9]+)">([^<]*)</page>', body)
    return props, body, len(body), child_urls
