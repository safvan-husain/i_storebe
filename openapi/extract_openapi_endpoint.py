#!/usr/bin/env python3
"""
extract_openapi_endpoint.py

Usage:
  python extract_openapi_endpoint.py \
    --in openapi.json \
    --path /business/profile \
    --method PUT \
    --out extracted-put-business_profile.json
"""

import json
import argparse
from pathlib import Path
from copy import deepcopy

COMPONENT_SECTIONS = {
    "schemas",
    "parameters",
    "responses",
    "requestBodies",
    "headers",
    "securitySchemes",
    "examples",
    "links",
    "callbacks",
    "pathItems",
}

def iter_refs(obj):
    """Yield every $ref string found anywhere inside obj."""
    if isinstance(obj, dict):
        if "$ref" in obj and isinstance(obj["$ref"], str):
            yield obj["$ref"]
        for v in obj.values():
            yield from iter_refs(v)
    elif isinstance(obj, list):
        for item in obj:
            yield from iter_refs(item)

def resolve_component_ref(ref: str):
    """
    Return (section, name) for a local component ref like '#/components/schemas/Foo'.
    Ignore external refs (http(s)://...) or non-component refs.
    """
    if not isinstance(ref, str) or not ref.startswith("#/components/"):
        return None
    parts = ref.split("/")
    # ["#", "components", "<section>", "<name>", ...maybe more]
    if len(parts) < 4:
        return None
    section = parts[2]
    name = "/".join(parts[3:])  # keep any extra slashes in the name part
    return section, name

def collect_security_schemes_from_security(spec, security_list, resolved_components):
    """Copy any securitySchemes referenced by the given security list into resolved_components."""
    if not security_list or not isinstance(security_list, list):
        return
    sec_src = spec.get("components", {}).get("securitySchemes", {})
    for sec_obj in security_list:
        if isinstance(sec_obj, dict):
            for scheme_name in sec_obj.keys():
                scheme = sec_src.get(scheme_name)
                if scheme is not None:
                    resolved_components.setdefault("securitySchemes", {})
                    if scheme_name not in resolved_components["securitySchemes"]:
                        resolved_components["securitySchemes"][scheme_name] = deepcopy(scheme)

def main():
    ap = argparse.ArgumentParser(description="Extract one endpoint + referenced components from an OpenAPI JSON.")
    ap.add_argument("--in", dest="infile", required=True, help="Path to the OpenAPI JSON file")
    ap.add_argument("--path", dest="target_path", required=True, help="Endpoint path (e.g. /business/profile)")
    ap.add_argument("--method", dest="target_method", required=True, help="HTTP method (GET, POST, PUT, etc.)")
    ap.add_argument("--out", dest="outfile", required=True, help="Path to write the minimal JSON")
    args = ap.parse_args()

    infile = Path(args.infile)
    outfile = Path(args.outfile)
    target_path = args.target_path
    target_method = args.target_method.lower()

    with infile.open("r", encoding="utf-8") as f:
        spec = json.load(f)

    paths = spec.get("paths", {})
    if target_path not in paths:
        raise SystemExit(f"Path not found in spec: {target_path}")

    # Methods in OpenAPI are lower-case keys
    path_item = paths[target_path]
    method_keys = {k.lower(): k for k in path_item.keys()}  # map lower->original
    if target_method not in method_keys:
        raise SystemExit(f"Method not found for {target_path}: {args.target_method}")

    method_key_original = method_keys[target_method]
    operation = path_item[method_key_original]

    # Start collecting $refs from operation and path-level (parameters/security)
    collected_refs = set()

    def collect_from_obj(obj):
        for ref in iter_refs(obj):
            collected_refs.add(ref)

    collect_from_obj(operation)
    for key in ("parameters", "security", "servers"):
        if key in path_item:
            collect_from_obj(path_item[key])

    # Resolve components transitively
    resolved_components = {section: {} for section in COMPONENT_SECTIONS}

    def add_component(section, name):
        comp_src = spec.get("components", {}).get(section, {}).get(name)
        if comp_src is None:
            return
        if name in resolved_components[section]:
            return
        resolved_components[section][name] = deepcopy(comp_src)
        # Collect nested refs inside this component
        collect_from_obj(comp_src)

    # BFS/DFS over collected refs
    queue = list(collected_refs)
    seen = set()
    while queue:
        ref = queue.pop()
        if ref in seen:
            continue
        seen.add(ref)
        resolved = resolve_component_ref(ref)
        if not resolved:
            continue  # skip external or non-component refs
        section, name = resolved
        if section not in COMPONENT_SECTIONS:
            continue
        before_len = len(collected_refs)
        add_component(section, name)
        # Any new refs found inside that component were added to collected_refs.
        # Push newly discovered refs (those not yet seen) onto the queue.
        for new_ref in list(collected_refs):
            if new_ref not in seen:
                queue.append(new_ref)

    # Include security schemes referenced at operation/path/top-level
    collect_security_schemes_from_security(spec, operation.get("security"), resolved_components)
    collect_security_schemes_from_security(spec, path_item.get("security"), resolved_components)
    collect_security_schemes_from_security(spec, spec.get("security"), resolved_components)

    # Build minimal spec
    minimal = {
        "openapi": spec.get("openapi", "3.0.0"),
        "info": {
            "title": spec.get("info", {}).get("title", "Extracted API"),
            "version": spec.get("info", {}).get("version", "1.0.0"),
            "description": f"Extracted {method_key_original.upper()} {target_path} and referenced components",
        },
        "paths": {
            target_path: {
                method_key_original: deepcopy(operation)
            }
        },
    }

    # Optionally carry over top-level servers (you can comment this out if you don't want them)
    if spec.get("servers"):
        minimal["servers"] = deepcopy(spec["servers"])

    # Prune empty component sections
    non_empty_components = {k: v for k, v in resolved_components.items() if v}
    if non_empty_components:
        minimal["components"] = non_empty_components

    # Write output
    outfile.parent.mkdir(parents=True, exist_ok=True)
    with outfile.open("w", encoding="utf-8") as f:
        json.dump(minimal, f, indent=2, ensure_ascii=False)

    print(f"✅ Wrote minimal spec to: {outfile}")

if __name__ == "__main__":
    main()
