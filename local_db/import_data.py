"""Sync local_db/Consolidated_Cases.csv into the normalized Google Sheet.

The master workbook is not a single flat sheet.  Consolidated_Cases.csv is a
frontend-friendly view, while the Google Sheet stores case data across related
tabs such as CaseMaster, Accused, Victim, ComplainantDetails, and others.

This script reads the lookup tabs, converts display values into master IDs,
replaces rows for the local CaseMasterID values, and preserves unrelated rows.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
DEFAULT_CSV_PATH = ROOT / "Consolidated_Cases.csv"
SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]

SYNC_TABS = [
    "CaseMaster",
    "Accused",
    "Victim",
    "ComplainantDetails",
    "ChargesheetDetails",
    "ArrestSurrender",
    "ActSectionAssociation",
]

LOOKUP_TABS = [
    "Act",
    "CaseCategory",
    "CaseStatusMaster",
    "Court",
    "CrimeHead",
    "CrimeSubHead",
    "District",
    "Employee",
    "GravityOffence",
    "Section",
    "Unit",
]

REQUIRED_LOCAL_COLUMNS = [
    "CaseMasterID",
    "CrimeNo",
    "CaseNo",
    "CrimeRegisteredDate",
    "CrimeHead",
    "CrimeSubHead",
    "PoliceStation",
    "District",
    "Court",
    "EmployeeID",
    "Officer",
    "Status",
    "CaseCategory",
    "Gravity",
    "AccusedNames",
    "VictimNames",
    "Complainant",
    "ArrestCount",
    "ChargesheetCount",
    "LatestChargesheetDate",
    "ChargesheetStatus",
    "Acts",
    "Sections",
    "InfoReceivedPSDate",
    "IncidentFromDate",
    "IncidentToDate",
    "Latitude",
    "Longitude",
    "BriefFacts",
]

CRIME_HEAD_ALIASES = {
    "crimes against body": "Body",
    "body offences": "Body",
    "crimes against property": "Property",
    "property offences": "Property",
    "crimes against women": "Women",
    "women related offences": "Women",
    "cyber crimes": "Cyber",
    "cyber offences": "Cyber",
    "narcotic offences": "Narcotics",
    "narcotics offences": "Narcotics",
    "crimes against public order": "Public Order",
    "public order offences": "Public Order",
    "traffic violations": "Traffic",
}

ACT_ALIASES = {
    "bns": "BNS",
    "bharatiya nyaya sanhita": "BNS",
    "ndps": "NDPS",
    "ndps act": "NDPS",
    "narcotic drugs and psychotropic substances act": "NDPS",
    "mv act": "MVACT",
    "motor vehicle act": "MVACT",
    "motor vehicles act": "MVACT",
    "it act": "ITACT",
    "information technology act": "ITACT",
    "pocso": "POCSO",
    "pocso act": "POCSO",
    "dp act": "DPACT",
    "dowry prohibition act": "DPACT",
}


@dataclass
class SheetTable:
    name: str
    headers: list[str]
    rows: list[dict[str, str]]


def clean(value: Any) -> str:
    return "" if value is None else str(value).strip()


def norm(value: Any) -> str:
    text = clean(value).lower().replace("&", " and ")
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def station_key(value: Any) -> str:
    words = [
        word
        for word in norm(value).split()
        if word not in {"police", "station", "ps", "p", "s"}
    ]
    return " ".join(words)


def intish(value: Any) -> str:
    text = clean(value)
    if not text:
        return ""
    try:
        return str(int(float(text)))
    except ValueError:
        return text


def parse_count(value: Any) -> int:
    text = clean(value)
    if not text:
        return 0
    try:
        return max(0, int(float(text)))
    except ValueError:
        return 0


def split_multi(value: Any) -> list[str]:
    text = clean(value)
    if not text:
        return []
    return [part.strip() for part in re.split(r";|\n", text) if part.strip()]


def first_present(*values: Any) -> str:
    for value in values:
        text = clean(value)
        if text:
            return text
    return ""


def row_key(row: dict[str, str], field: str) -> str:
    return intish(row.get(field, ""))


def sort_case_key(row: dict[str, str], field: str = "CaseMasterID") -> tuple[int, str]:
    key = row_key(row, field)
    try:
        return (0, f"{int(key):012d}")
    except ValueError:
        return (1, key)


def max_numeric_id(rows: list[dict[str, str]], field: str) -> int:
    current = 0
    for row in rows:
        text = row_key(row, field)
        if not text:
            continue
        try:
            current = max(current, int(text))
        except ValueError:
            continue
    return current


def make_id_allocator(rows: list[dict[str, str]], field: str):
    current = max_numeric_id(rows, field)

    def next_id() -> str:
        nonlocal current
        current += 1
        return str(current)

    return next_id


def empty_record(headers: list[str]) -> dict[str, str]:
    return {header: "" for header in headers}


def set_cell(record: dict[str, str], header: str, value: Any) -> None:
    if header in record:
        record[header] = clean(value)


def copy_preserved(
    record: dict[str, str],
    existing: dict[str, str] | None,
    fields: list[str],
) -> None:
    if not existing:
        return
    for field in fields:
        if field in record and not clean(record.get(field)):
            record[field] = clean(existing.get(field, ""))


def read_local_cases(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        raise FileNotFoundError(f"CSV file not found: {path}")

    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames:
            raise RuntimeError("Consolidated_Cases.csv has no header row.")

        missing = [column for column in REQUIRED_LOCAL_COLUMNS if column not in reader.fieldnames]
        if missing:
            raise RuntimeError(f"Consolidated_Cases.csv is missing columns: {', '.join(missing)}")

        cases_by_id: dict[str, dict[str, str]] = {}
        order: list[str] = []
        for row in reader:
            case_id = intish(row.get("CaseMasterID", ""))
            if not case_id:
                continue
            normalized = {key: clean(value) for key, value in row.items()}
            normalized["CaseMasterID"] = case_id
            if case_id not in cases_by_id:
                order.append(case_id)
            cases_by_id[case_id] = normalized

    return [cases_by_id[case_id] for case_id in order]


def load_service_account_info() -> dict[str, Any]:
    raw = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON", "").strip()
    if raw:
        if raw.startswith("{"):
            return json.loads(raw)
        path = Path(raw)
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
        raise FileNotFoundError(f"GOOGLE_SERVICE_ACCOUNT_JSON path does not exist: {path}")

    credentials_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
    if credentials_path:
        path = Path(credentials_path)
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
        raise FileNotFoundError(f"GOOGLE_APPLICATION_CREDENTIALS path does not exist: {path}")

    local_path = ROOT / "service_account.json"
    if local_path.exists():
        return json.loads(local_path.read_text(encoding="utf-8"))

    raise RuntimeError(
        "Google Sheets credentials are not configured. Put service_account.json in local_db "
        "or set GOOGLE_SERVICE_ACCOUNT_JSON / GOOGLE_APPLICATION_CREDENTIALS."
    )


def service_account_token() -> str:
    try:
        from google.auth.transport.requests import Request
        from google.oauth2 import service_account
    except ImportError as exc:
        raise RuntimeError(
            "Missing Google auth libraries. Install google-auth and requests in the Python "
            "environment that runs local_db/import_data.py."
        ) from exc

    credentials = service_account.Credentials.from_service_account_info(
        load_service_account_info(),
        scopes=SCOPES,
    )
    credentials.refresh(Request())
    if not credentials.token:
        raise RuntimeError("Google auth succeeded but no access token was returned.")
    return credentials.token


def google_request(
    method: str,
    url: str,
    token: str,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            body = response.read().decode("utf-8", errors="replace")
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Google Sheets API failed: HTTP {exc.code} {body}") from exc


def quoted_range(value: str) -> str:
    return f"'{value.replace(chr(39), chr(39) + chr(39))}'"


def encoded_range(tab: str, cell_range: str) -> str:
    return urllib.parse.quote(f"{quoted_range(tab)}!{cell_range}", safe="")


def column_name(index: int) -> str:
    result = ""
    while index:
        index, remainder = divmod(index - 1, 26)
        result = chr(65 + remainder) + result
    return result


def get_values(spreadsheet_id: str, token: str, tab: str) -> list[list[str]]:
    range_name = encoded_range(tab, "A:Z")
    url = f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{range_name}"
    response = google_request("GET", url, token)
    return response.get("values", [])


def clear_values(spreadsheet_id: str, token: str, tab: str, column_count: int) -> None:
    last_column = column_name(max(1, column_count))
    range_name = encoded_range(tab, f"A:{last_column}")
    url = f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{range_name}:clear"
    google_request("POST", url, token, {})


def update_values(
    spreadsheet_id: str,
    token: str,
    tab: str,
    values: list[list[str]],
) -> None:
    range_name = encoded_range(tab, "A1")
    url = (
        f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{range_name}"
        "?valueInputOption=RAW"
    )
    google_request("PUT", url, token, {"majorDimension": "ROWS", "values": values})


def values_to_table(tab: str, values: list[list[str]]) -> SheetTable:
    if not values:
        raise RuntimeError(f"Google Sheet tab '{tab}' is empty or could not be read.")

    headers = [clean(header) for header in values[0]]
    rows: list[dict[str, str]] = []
    for raw_row in values[1:]:
        if not any(clean(value) for value in raw_row):
            continue
        record = empty_record(headers)
        for index, header in enumerate(headers):
            record[header] = clean(raw_row[index]) if index < len(raw_row) else ""
        rows.append(record)
    return SheetTable(tab, headers, rows)


def table_to_values(table: SheetTable) -> list[list[str]]:
    return [table.headers] + [
        [clean(row.get(header, "")) for header in table.headers] for row in table.rows
    ]


def read_tables(spreadsheet_id: str, token: str) -> dict[str, SheetTable]:
    tables: dict[str, SheetTable] = {}
    for tab in sorted(set(SYNC_TABS + LOOKUP_TABS)):
        tables[tab] = values_to_table(tab, get_values(spreadsheet_id, token, tab))
    return tables


def add_unique(mapping: dict[str, set[str]], key: Any, value: Any) -> None:
    normalized = norm(key)
    stored = clean(value)
    if normalized and stored:
        mapping[normalized].add(stored)


def unique_value(mapping: dict[str, set[str]], value: Any) -> str:
    candidates = mapping.get(norm(value), set())
    return next(iter(candidates)) if len(candidates) == 1 else ""


def build_lookup_store(tables: dict[str, SheetTable]) -> dict[str, Any]:
    lookups: dict[str, Any] = {
        "act": {},
        "case_category": {},
        "case_status": {},
        "court": {},
        "crime_head": {},
        "crime_subhead_by_head": {},
        "crime_subhead_global": defaultdict(set),
        "district": {},
        "district_state": {},
        "employee_ids": set(),
        "employee_name": defaultdict(set),
        "gravity": {},
        "section_by_act": {},
        "section_global": defaultdict(set),
        "unit": {},
        "unit_station": defaultdict(set),
    }

    for row in tables["Act"].rows:
        code = clean(row.get("ActCode"))
        if not code:
            continue
        for field in ("ActCode", "ShortName", "ActDescription"):
            if clean(row.get(field)):
                lookups["act"][norm(row[field])] = code
        lookups["act"][norm(code)] = code

    for alias, code in ACT_ALIASES.items():
        if norm(code) in lookups["act"]:
            lookups["act"][alias] = lookups["act"][norm(code)]

    for row in tables["Section"].rows:
        act_code = clean(row.get("ActCode"))
        section_code = clean(row.get("SectionCode"))
        description = clean(row.get("SectionDescription"))
        if not section_code:
            continue
        keys = {norm(section_code), norm(description)}
        for key in keys:
            if not key:
                continue
            if act_code:
                lookups["section_by_act"][(norm(act_code), key)] = section_code
            lookups["section_global"][key].add((act_code, section_code))

    for row in tables["CaseCategory"].rows:
        value = clean(row.get("LookupValue"))
        category_id = clean(row.get("CaseCategoryID"))
        if value and category_id:
            lookups["case_category"][norm(value)] = category_id

    for row in tables["CaseStatusMaster"].rows:
        value = clean(row.get("CaseStatusName"))
        status_id = clean(row.get("CaseStatusID"))
        if value and status_id:
            lookups["case_status"][norm(value)] = status_id

    for row in tables["Court"].rows:
        value = clean(row.get("CourtName"))
        court_id = clean(row.get("CourtID"))
        if value and court_id:
            lookups["court"][norm(value)] = court_id

    for row in tables["CrimeHead"].rows:
        value = clean(row.get("CrimeGroupName"))
        head_id = clean(row.get("CrimeHeadID"))
        if value and head_id:
            lookups["crime_head"][norm(value)] = head_id

    for alias, target in CRIME_HEAD_ALIASES.items():
        if norm(target) in lookups["crime_head"]:
            lookups["crime_head"][alias] = lookups["crime_head"][norm(target)]

    for row in tables["CrimeSubHead"].rows:
        value = clean(row.get("CrimeHeadName"))
        subhead_id = clean(row.get("CrimeSubHeadID"))
        head_id = clean(row.get("CrimeHeadID"))
        if not value or not subhead_id:
            continue
        lookups["crime_subhead_global"][norm(value)].add(subhead_id)
        if head_id:
            lookups["crime_subhead_by_head"][(head_id, norm(value))] = subhead_id

    for row in tables["District"].rows:
        value = clean(row.get("DistrictName"))
        district_id = clean(row.get("DistrictID"))
        state_id = clean(row.get("StateID"))
        if value and district_id:
            lookups["district"][norm(value)] = district_id
            lookups["district_state"][district_id] = state_id

    for row in tables["Employee"].rows:
        employee_id = clean(row.get("EmployeeID"))
        if employee_id:
            lookups["employee_ids"].add(employee_id)
        name = clean(row.get("FirstName"))
        if employee_id and name:
            lookups["employee_name"][norm(name)].add(employee_id)

    for row in tables["GravityOffence"].rows:
        value = clean(row.get("LookupValue"))
        gravity_id = clean(row.get("GravityOffenceID"))
        if value and gravity_id:
            lookups["gravity"][norm(value)] = gravity_id

    for row in tables["Unit"].rows:
        unit_id = clean(row.get("UnitID"))
        unit_name = clean(row.get("UnitName"))
        if not unit_id or not unit_name:
            continue
        lookups["unit"][norm(unit_name)] = unit_id
        add_unique(lookups["unit_station"], station_key(unit_name), unit_id)

    return lookups


def lookup_named(
    mapping: dict[str, str],
    value: Any,
    label: str,
    missing: dict[str, Counter[str]],
    aliases: dict[str, str] | None = None,
) -> str:
    raw = clean(value)
    if not raw:
        return ""

    candidates = [raw]
    if aliases and norm(raw) in aliases:
        candidates.insert(0, aliases[norm(raw)])

    for candidate in candidates:
        result = mapping.get(norm(candidate))
        if result:
            return result

    missing[label][raw] += 1
    return ""


def lookup_station(
    lookups: dict[str, Any],
    value: Any,
    missing: dict[str, Counter[str]],
) -> str:
    raw = clean(value)
    if not raw:
        return ""
    exact = lookups["unit"].get(norm(raw))
    if exact:
        return exact
    relaxed = unique_value(lookups["unit_station"], station_key(raw))
    if relaxed:
        return relaxed
    missing["PoliceStation"][raw] += 1
    return ""


def lookup_employee(
    lookups: dict[str, Any],
    local_case: dict[str, str],
    missing: dict[str, Counter[str]],
) -> str:
    employee_id = intish(local_case.get("EmployeeID", ""))
    if employee_id:
        if employee_id not in lookups["employee_ids"]:
            missing["EmployeeID not in Employee"][employee_id] += 1
        return employee_id

    officer = clean(local_case.get("Officer", ""))
    if officer:
        ids = lookups["employee_name"].get(norm(officer), set())
        if len(ids) == 1:
            return next(iter(ids))
        missing["Officer"][officer] += 1
    return ""


def lookup_crime_subhead(
    lookups: dict[str, Any],
    head_id: str,
    value: Any,
    missing: dict[str, Counter[str]],
) -> str:
    raw = clean(value)
    if not raw:
        return ""

    if head_id:
        result = lookups["crime_subhead_by_head"].get((head_id, norm(raw)))
        if result:
            return result

    candidates = lookups["crime_subhead_global"].get(norm(raw), set())
    if len(candidates) == 1:
        return next(iter(candidates))

    missing["CrimeSubHead"][raw] += 1
    return ""


def lookup_section(
    lookups: dict[str, Any],
    act_code: str,
    section_value: str,
    missing: dict[str, Counter[str]],
) -> tuple[str, str]:
    raw = clean(section_value)
    if not raw:
        return act_code, ""

    keys = [norm(raw)]
    if raw.lower().startswith("section "):
        keys.append(norm(raw[8:]))

    for key in keys:
        if act_code:
            section_code = lookups["section_by_act"].get((norm(act_code), key))
            if section_code:
                return act_code, section_code

        global_matches = lookups["section_global"].get(key, set())
        if len(global_matches) == 1:
            matched_act, section_code = next(iter(global_matches))
            return act_code or matched_act, section_code

    for (candidate_act, key), section_code in lookups["section_by_act"].items():
        if act_code and candidate_act != norm(act_code):
            continue
        if key and (key in norm(raw) or norm(raw) in key):
            return act_code, section_code

    missing["Section"][raw] += 1
    return act_code, ""


def existing_by_case_and_name(
    rows: list[dict[str, str]],
    name_field: str,
) -> dict[tuple[str, str], dict[str, str]]:
    result: dict[tuple[str, str], dict[str, str]] = {}
    for row in rows:
        case_id = row_key(row, "CaseMasterID")
        name = norm(row.get(name_field, ""))
        if case_id and name:
            result[(case_id, name)] = row
    return result


def existing_list_by_case(
    rows: list[dict[str, str]],
    case_field: str = "CaseMasterID",
) -> dict[str, list[dict[str, str]]]:
    result: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in rows:
        case_id = row_key(row, case_field)
        if case_id:
            result[case_id].append(row)
    return result


def replace_by_key(
    existing_rows: list[dict[str, str]],
    new_rows: list[dict[str, str]],
    key_field: str,
) -> list[dict[str, str]]:
    new_by_key = {row_key(row, key_field): row for row in new_rows}
    used: set[str] = set()
    output: list[dict[str, str]] = []

    for row in existing_rows:
        key = row_key(row, key_field)
        if key in new_by_key:
            output.append(new_by_key[key])
            used.add(key)
        else:
            output.append(row)

    for row in new_rows:
        key = row_key(row, key_field)
        if key not in used:
            output.append(row)

    return output


def replace_child_cases(
    existing_rows: list[dict[str, str]],
    new_rows: list[dict[str, str]],
    case_ids: set[str],
    case_field: str = "CaseMasterID",
) -> list[dict[str, str]]:
    kept = [row for row in existing_rows if row_key(row, case_field) not in case_ids]
    return kept + sorted(new_rows, key=lambda row: sort_case_key(row, case_field))


def build_case_master_rows(
    cases: list[dict[str, str]],
    table: SheetTable,
    lookups: dict[str, Any],
    missing: dict[str, Counter[str]],
) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for local_case in cases:
        record = empty_record(table.headers)
        case_id = row_key(local_case, "CaseMasterID")
        district_id = lookup_named(lookups["district"], local_case.get("District"), "District", missing)
        head_id = lookup_named(
            lookups["crime_head"],
            local_case.get("CrimeHead"),
            "CrimeHead",
            missing,
            CRIME_HEAD_ALIASES,
        )

        values = {
            "CaseMasterID": case_id,
            "CrimeNo": local_case.get("CrimeNo", ""),
            "CaseNo": local_case.get("CaseNo", ""),
            "CrimeRegisteredDate": local_case.get("CrimeRegisteredDate", ""),
            "PolicePersonID": lookup_employee(lookups, local_case, missing),
            "PoliceStationID": lookup_station(lookups, local_case.get("PoliceStation"), missing),
            "CaseCategoryID": lookup_named(
                lookups["case_category"], local_case.get("CaseCategory"), "CaseCategory", missing
            ),
            "GravityOffenceID": lookup_named(
                lookups["gravity"], local_case.get("Gravity"), "Gravity", missing
            ),
            "CrimeMajorHeadID": head_id,
            "CrimeMinorHeadID": lookup_crime_subhead(
                lookups, head_id, local_case.get("CrimeSubHead"), missing
            ),
            "CaseStatusID": lookup_named(
                lookups["case_status"], local_case.get("Status"), "Status", missing
            ),
            "CourtID": lookup_named(lookups["court"], local_case.get("Court"), "Court", missing),
            "IncidentFromDate": local_case.get("IncidentFromDate", ""),
            "IncidentToDate": local_case.get("IncidentToDate", ""),
            "InfoReceivedPSDate": local_case.get("InfoReceivedPSDate", ""),
            "latitude": local_case.get("Latitude", ""),
            "longitude": local_case.get("Longitude", ""),
            "BriefFacts": local_case.get("BriefFacts", ""),
        }

        for header, value in values.items():
            set_cell(record, header, value)

        if not district_id and clean(local_case.get("District")):
            missing["District"][local_case["District"]] += 1
        rows.append(record)
    return rows


def build_accused_rows(
    cases: list[dict[str, str]],
    table: SheetTable,
    next_id,
) -> tuple[list[dict[str, str]], dict[tuple[str, str], str]]:
    existing = existing_by_case_and_name(table.rows, "AccusedName")
    rows: list[dict[str, str]] = []
    ids_by_case_name: dict[tuple[str, str], str] = {}

    for local_case in cases:
        case_id = row_key(local_case, "CaseMasterID")
        for name in split_multi(local_case.get("AccusedNames", "")):
            old = existing.get((case_id, norm(name)))
            accused_id = row_key(old or {}, "AccusedMasterID") or next_id()
            record = empty_record(table.headers)
            set_cell(record, "AccusedMasterID", accused_id)
            set_cell(record, "CaseMasterID", case_id)
            set_cell(record, "AccusedName", name)
            copy_preserved(record, old, ["AgeYear", "GenderID", "PersonID"])
            rows.append(record)
            ids_by_case_name[(case_id, norm(name))] = accused_id

    return rows, ids_by_case_name


def build_victim_rows(cases: list[dict[str, str]], table: SheetTable, next_id) -> list[dict[str, str]]:
    existing = existing_by_case_and_name(table.rows, "VictimName")
    rows: list[dict[str, str]] = []

    for local_case in cases:
        case_id = row_key(local_case, "CaseMasterID")
        for name in split_multi(local_case.get("VictimNames", "")):
            old = existing.get((case_id, norm(name)))
            record = empty_record(table.headers)
            set_cell(record, "VictimMasterID", row_key(old or {}, "VictimMasterID") or next_id())
            set_cell(record, "CaseMasterID", case_id)
            set_cell(record, "VictimName", name)
            copy_preserved(record, old, ["AgeYear", "GenderID", "VictimPolice"])
            rows.append(record)

    return rows


def build_complainant_rows(
    cases: list[dict[str, str]],
    table: SheetTable,
    next_id,
) -> list[dict[str, str]]:
    existing = existing_by_case_and_name(table.rows, "ComplainantName")
    rows: list[dict[str, str]] = []

    for local_case in cases:
        case_id = row_key(local_case, "CaseMasterID")
        name = clean(local_case.get("Complainant", ""))
        if not name:
            continue
        old = existing.get((case_id, norm(name)))
        record = empty_record(table.headers)
        set_cell(record, "ComplainantID", row_key(old or {}, "ComplainantID") or next_id())
        set_cell(record, "CaseMasterID", case_id)
        set_cell(record, "ComplainantName", name)
        copy_preserved(record, old, ["AgeYear", "OccupationID", "ReligionID", "CasteID", "GenderID"])
        rows.append(record)

    return rows


def build_chargesheet_rows(
    cases: list[dict[str, str]],
    table: SheetTable,
    next_id,
) -> list[dict[str, str]]:
    existing = existing_list_by_case(table.rows)
    rows: list[dict[str, str]] = []

    for local_case in cases:
        count = parse_count(local_case.get("ChargesheetCount"))
        latest_date = clean(local_case.get("LatestChargesheetDate"))
        status = clean(local_case.get("ChargesheetStatus"))
        if count == 0 and (latest_date or norm(status) == "filed"):
            count = 1
        if count == 0:
            continue

        case_id = row_key(local_case, "CaseMasterID")
        old_rows = existing.get(case_id, [])
        for index in range(count):
            old = old_rows[index] if index < len(old_rows) else None
            record = empty_record(table.headers)
            set_cell(record, "CSID", row_key(old or {}, "CSID") or next_id())
            set_cell(record, "CaseMasterID", case_id)
            set_cell(record, "csdate", latest_date or clean((old or {}).get("csdate")))
            set_cell(record, "cstype", first_present(status, (old or {}).get("cstype"), "Filed"))
            set_cell(record, "PolicePersonID", intish(local_case.get("EmployeeID", "")))
            rows.append(record)

    return rows


def build_arrest_rows(
    cases: list[dict[str, str]],
    table: SheetTable,
    accused_ids: dict[tuple[str, str], str],
    lookups: dict[str, Any],
    missing: dict[str, Counter[str]],
    next_id,
) -> list[dict[str, str]]:
    existing = existing_list_by_case(table.rows)
    rows: list[dict[str, str]] = []

    for local_case in cases:
        count = parse_count(local_case.get("ArrestCount"))
        if count == 0:
            continue

        case_id = row_key(local_case, "CaseMasterID")
        names = split_multi(local_case.get("AccusedNames", ""))
        old_rows = existing.get(case_id, [])
        district_id = lookup_named(lookups["district"], local_case.get("District"), "District", missing)
        state_id = lookups["district_state"].get(district_id, "")
        station_id = lookup_station(lookups, local_case.get("PoliceStation"), missing)
        court_id = lookup_named(lookups["court"], local_case.get("Court"), "Court", missing)

        if not names:
            missing["Arrest without accused"][case_id] += 1
            continue

        for index, name in enumerate(names[:count]):
            accused_id = accused_ids.get((case_id, norm(name)), "")
            old = old_rows[index] if index < len(old_rows) else None
            record = empty_record(table.headers)
            set_cell(record, "ArrestSurrenderID", row_key(old or {}, "ArrestSurrenderID") or next_id())
            set_cell(record, "CaseMasterID", case_id)
            set_cell(record, "ArrestSurrenderTypeID", first_present((old or {}).get("ArrestSurrenderTypeID"), "1"))
            set_cell(
                record,
                "ArrestSurrenderDate",
                first_present((old or {}).get("ArrestSurrenderDate"), local_case.get("CrimeRegisteredDate")),
            )
            set_cell(record, "ArrestSurrenderStateId", first_present((old or {}).get("ArrestSurrenderStateId"), state_id))
            set_cell(
                record,
                "ArrestSurrenderDistrictId",
                first_present((old or {}).get("ArrestSurrenderDistrictId"), district_id),
            )
            set_cell(record, "PoliceStationID", first_present(station_id, (old or {}).get("PoliceStationID")))
            set_cell(record, "IOID", first_present(intish(local_case.get("EmployeeID", "")), (old or {}).get("IOID")))
            set_cell(record, "CourtID", first_present(court_id, (old or {}).get("CourtID")))
            set_cell(record, "AccusedMasterID", accused_id)
            set_cell(record, "IsAccused", first_present((old or {}).get("IsAccused"), "1"))
            set_cell(record, "IsComplainantAccused", first_present((old or {}).get("IsComplainantAccused"), "0"))
            rows.append(record)

    return rows


def build_act_section_rows(
    cases: list[dict[str, str]],
    table: SheetTable,
    lookups: dict[str, Any],
    missing: dict[str, Counter[str]],
) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []

    for local_case in cases:
        case_id = row_key(local_case, "CaseMasterID")
        acts = split_multi(local_case.get("Acts", ""))
        sections = split_multi(local_case.get("Sections", ""))
        total = max(len(acts), len(sections))
        if total == 0:
            continue

        for index in range(total):
            raw_act = acts[index] if index < len(acts) else (acts[-1] if acts else "")
            raw_section = sections[index] if index < len(sections) else ""
            act_code = lookup_named(lookups["act"], raw_act, "Act", missing, ACT_ALIASES)
            act_code, section_code = lookup_section(lookups, act_code, raw_section, missing)

            if not act_code and not section_code:
                continue

            record = empty_record(table.headers)
            set_cell(record, "CaseMasterID", case_id)
            set_cell(record, "ActID", act_code)
            set_cell(record, "SectionID", section_code)
            set_cell(record, "ActOrderID", str(index + 1))
            set_cell(record, "SectionOrderID", str(index + 1))
            rows.append(record)

    return rows


def build_payload(
    cases: list[dict[str, str]],
    tables: dict[str, SheetTable],
) -> tuple[dict[str, SheetTable], dict[str, Any]]:
    lookups = build_lookup_store(tables)
    missing: dict[str, Counter[str]] = defaultdict(Counter)
    case_ids = {row_key(local_case, "CaseMasterID") for local_case in cases}

    output: dict[str, SheetTable] = {
        tab: SheetTable(tables[tab].name, tables[tab].headers, list(tables[tab].rows))
        for tab in SYNC_TABS
    }

    new_case_master = build_case_master_rows(cases, tables["CaseMaster"], lookups, missing)
    new_accused, accused_ids = build_accused_rows(
        cases,
        tables["Accused"],
        make_id_allocator(tables["Accused"].rows, "AccusedMasterID"),
    )
    new_victims = build_victim_rows(
        cases,
        tables["Victim"],
        make_id_allocator(tables["Victim"].rows, "VictimMasterID"),
    )
    new_complainants = build_complainant_rows(
        cases,
        tables["ComplainantDetails"],
        make_id_allocator(tables["ComplainantDetails"].rows, "ComplainantID"),
    )
    new_chargesheets = build_chargesheet_rows(
        cases,
        tables["ChargesheetDetails"],
        make_id_allocator(tables["ChargesheetDetails"].rows, "CSID"),
    )
    new_arrests = build_arrest_rows(
        cases,
        tables["ArrestSurrender"],
        accused_ids,
        lookups,
        missing,
        make_id_allocator(tables["ArrestSurrender"].rows, "ArrestSurrenderID"),
    )
    new_act_sections = build_act_section_rows(cases, tables["ActSectionAssociation"], lookups, missing)

    output["CaseMaster"].rows = replace_by_key(tables["CaseMaster"].rows, new_case_master, "CaseMasterID")
    output["Accused"].rows = replace_child_cases(tables["Accused"].rows, new_accused, case_ids)
    output["Victim"].rows = replace_child_cases(tables["Victim"].rows, new_victims, case_ids)
    output["ComplainantDetails"].rows = replace_child_cases(
        tables["ComplainantDetails"].rows,
        new_complainants,
        case_ids,
    )
    output["ChargesheetDetails"].rows = replace_child_cases(
        tables["ChargesheetDetails"].rows,
        new_chargesheets,
        case_ids,
    )
    output["ArrestSurrender"].rows = replace_child_cases(tables["ArrestSurrender"].rows, new_arrests, case_ids)
    output["ActSectionAssociation"].rows = replace_child_cases(
        tables["ActSectionAssociation"].rows,
        new_act_sections,
        case_ids,
    )

    existing_case_ids = {row_key(row, "CaseMasterID") for row in tables["CaseMaster"].rows}
    summary = {
        "local_cases": len(cases),
        "case_updates": len(case_ids & existing_case_ids),
        "case_inserts": len(case_ids - existing_case_ids),
        "generated": {
            "Accused": len(new_accused),
            "Victim": len(new_victims),
            "ComplainantDetails": len(new_complainants),
            "ChargesheetDetails": len(new_chargesheets),
            "ArrestSurrender": len(new_arrests),
            "ActSectionAssociation": len(new_act_sections),
        },
        "final_rows": {tab: len(output[tab].rows) for tab in SYNC_TABS},
        "missing": missing,
    }
    return output, summary


def print_summary(summary: dict[str, Any], dry_run: bool) -> None:
    mode = "DRY RUN" if dry_run else "WRITE"
    print(f"Mode: {mode}")
    print(f"Local cases: {summary['local_cases']}")
    print(f"CaseMaster updates: {summary['case_updates']}")
    print(f"CaseMaster inserts: {summary['case_inserts']}")
    print("Generated rows:")
    for tab, count in summary["generated"].items():
        print(f"  {tab}: {count}")
    print("Final row counts:")
    for tab, count in summary["final_rows"].items():
        print(f"  {tab}: {count}")

    missing: dict[str, Counter[str]] = summary["missing"]
    non_empty = {key: counter for key, counter in missing.items() if counter}
    if not non_empty:
        print("Lookup gaps: none")
        return

    print("Lookup gaps:")
    for key in sorted(non_empty):
        counter = non_empty[key]
        examples = ", ".join(f"{value} ({count})" for value, count in counter.most_common(5))
        print(f"  {key}: {sum(counter.values())} missing; examples: {examples}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Sync Consolidated_Cases.csv to normalized Google Sheets tabs.")
    parser.add_argument(
        "--csv",
        default=os.getenv("CONSOLIDATED_CASES_CSV", str(DEFAULT_CSV_PATH)),
        help="Path to Consolidated_Cases.csv",
    )
    parser.add_argument(
        "--spreadsheet-id",
        default=os.getenv("GOOGLE_MASTER_SHEET_ID") or os.getenv("GOOGLE_SHEET_ID", ""),
        help="Google Sheets spreadsheet ID",
    )
    parser.add_argument("--dry-run", action="store_true", help="Build the payload without writing to Google Sheets.")
    parser.add_argument("--limit", type=int, default=0, help="Only process the first N local cases, for testing.")
    return parser.parse_args()


def main() -> int:
    if os.getenv("GOOGLE_SHEETS_WEBHOOK_URL"):
        raise RuntimeError("GOOGLE_SHEETS_WEBHOOK_URL is not supported for normalized multi-tab sync.")

    args = parse_args()
    if not args.spreadsheet_id:
        raise RuntimeError(
            "GOOGLE_MASTER_SHEET_ID is required (or pass --spreadsheet-id)."
        )
    dry_run = args.dry_run or os.getenv("GOOGLE_SHEETS_DRY_RUN", "").strip() == "1"
    cases = read_local_cases(Path(args.csv))
    if args.limit > 0:
        cases = cases[: args.limit]
    if not cases:
        raise RuntimeError("No cases were found in Consolidated_Cases.csv.")

    token = service_account_token()
    tables = read_tables(args.spreadsheet_id, token)
    output, summary = build_payload(cases, tables)
    print_summary(summary, dry_run)

    if dry_run:
        print("No Google Sheets changes were written.")
        return 0

    for tab in SYNC_TABS:
        values = table_to_values(output[tab])
        clear_values(args.spreadsheet_id, token, tab, len(output[tab].headers))
        update_values(args.spreadsheet_id, token, tab, values)
        print(f"Synced {len(output[tab].rows)} rows to {tab}.")

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"import_data.py failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
