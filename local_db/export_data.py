"""Pull the normalized Google Sheet back into Consolidated_Cases.csv.

The portal reads a flat CSV, while the master Google Sheet keeps case data in
related tabs. This script reverses the import_data.py direction and rebuilds the
flat CSV from the current master tabs.
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable

from import_data import (
    DEFAULT_CSV_PATH,
    DEFAULT_SPREADSHEET_ID,
    LOOKUP_TABS,
    SYNC_TABS,
    SheetTable,
    clean,
    get_values,
    intish,
    service_account_token,
    sort_case_key,
    values_to_table,
)


CSV_HEADERS = [
    "CaseMasterID",
    "CrimeNo",
    "CaseNo",
    "CrimeRegisteredDate",
    "CrimeHead",
    "CrimeSubHead",
    "PoliceStation",
    "PoliceStationType",
    "District",
    "Court",
    "EmployeeID",
    "Officer",
    "OfficerRank",
    "OfficerDesignation",
    "Status",
    "CaseCategory",
    "Gravity",
    "AccusedCount",
    "AccusedNames",
    "VictimCount",
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

EXTRA_LOOKUP_TABS = ["Designation", "Rank", "UnitType"]


def first_present(*values: Any) -> str:
    for value in values:
        text = clean(value)
        if text:
            return text
    return ""


def display(row: dict[str, str] | None, fields: Iterable[str]) -> str:
    if not row:
        return ""
    return first_present(*(row.get(field, "") for field in fields))


def id_value(row: dict[str, str], fields: Iterable[str]) -> str:
    return intish(first_present(*(row.get(field, "") for field in fields)))


def index_by(rows: Iterable[dict[str, str]], fields: Iterable[str]) -> dict[str, dict[str, str]]:
    index: dict[str, dict[str, str]] = {}
    for row in rows:
        key = id_value(row, fields)
        if key and key not in index:
            index[key] = row
    return index


def group_by_case(rows: Iterable[dict[str, str]]) -> dict[str, list[dict[str, str]]]:
    grouped: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in rows:
        case_id = intish(row.get("CaseMasterID", ""))
        if case_id:
            grouped[case_id].append(row)
    return grouped


def sorted_rows(rows: Iterable[dict[str, str]], fields: Iterable[str]) -> list[dict[str, str]]:
    field_list = list(fields)

    def key(row: dict[str, str]) -> tuple[str, ...]:
        values: list[str] = []
        for field in field_list:
            value = intish(row.get(field, ""))
            if value.isdigit():
                values.append(f"{int(value):012d}")
            else:
                values.append(value)
        return tuple(values)

    return sorted(rows, key=key)


def join_unique(values: Iterable[str]) -> str:
    seen: set[str] = set()
    output: list[str] = []
    for value in values:
        text = clean(value)
        if not text:
            continue
        key = text.lower()
        if key in seen:
            continue
        seen.add(key)
        output.append(text)
    return "; ".join(output)


def latest_text(values: Iterable[str]) -> str:
    cleaned = [clean(value) for value in values if clean(value)]
    return max(cleaned) if cleaned else ""


def read_tab(spreadsheet_id: str, token: str, tab: str, required: bool = True) -> SheetTable:
    try:
        return values_to_table(tab, get_values(spreadsheet_id, token, tab))
    except Exception:
        if required:
            raise
        return SheetTable(tab, [], [])


def read_master_tables(spreadsheet_id: str, token: str) -> dict[str, SheetTable]:
    tables: dict[str, SheetTable] = {}
    for tab in sorted(set(SYNC_TABS + LOOKUP_TABS)):
        tables[tab] = read_tab(spreadsheet_id, token, tab, required=True)
    for tab in EXTRA_LOOKUP_TABS:
        if tab not in tables:
            tables[tab] = read_tab(spreadsheet_id, token, tab, required=False)
    return tables


def build_flat_cases(tables: dict[str, SheetTable]) -> list[dict[str, str]]:
    courts = index_by(tables["Court"].rows, ["CourtID"])
    units = index_by(tables["Unit"].rows, ["UnitID"])
    unit_types = index_by(tables.get("UnitType", SheetTable("UnitType", [], [])).rows, ["UnitTypeID", "TypeID"])
    districts = index_by(tables["District"].rows, ["DistrictID"])
    employees = index_by(tables["Employee"].rows, ["EmployeeID"])
    ranks = index_by(tables.get("Rank", SheetTable("Rank", [], [])).rows, ["RankID"])
    designations = index_by(
        tables.get("Designation", SheetTable("Designation", [], [])).rows,
        ["DesignationID"],
    )
    crime_heads = index_by(tables["CrimeHead"].rows, ["CrimeHeadID"])
    crime_subheads = index_by(tables["CrimeSubHead"].rows, ["CrimeSubHeadID"])
    statuses = index_by(tables["CaseStatusMaster"].rows, ["CaseStatusID"])
    categories = index_by(tables["CaseCategory"].rows, ["CaseCategoryID"])
    gravities = index_by(tables["GravityOffence"].rows, ["GravityOffenceID"])
    acts = index_by(tables["Act"].rows, ["ActCode"])
    sections = {
        (clean(row.get("ActCode")), clean(row.get("SectionCode"))): row
        for row in tables["Section"].rows
        if clean(row.get("SectionCode"))
    }

    accused_by_case = group_by_case(tables["Accused"].rows)
    victims_by_case = group_by_case(tables["Victim"].rows)
    complainants_by_case = group_by_case(tables["ComplainantDetails"].rows)
    chargesheets_by_case = group_by_case(tables["ChargesheetDetails"].rows)
    arrests_by_case = group_by_case(tables["ArrestSurrender"].rows)
    act_sections_by_case = group_by_case(tables["ActSectionAssociation"].rows)

    flat_cases: list[dict[str, str]] = []
    for case in sorted(tables["CaseMaster"].rows, key=sort_case_key):
        case_id = intish(case.get("CaseMasterID", ""))
        if not case_id:
            continue

        station = units.get(intish(case.get("PoliceStationID", "")))
        station_type_id = first_present(
            station.get("UnitTypeID", "") if station else "",
            station.get("TypeID", "") if station else "",
        )
        employee = employees.get(intish(case.get("PolicePersonID", "")))
        rank = ranks.get(intish(employee.get("RankID", ""))) if employee else None
        designation = designations.get(intish(employee.get("DesignationID", ""))) if employee else None

        accused_rows = sorted_rows(accused_by_case.get(case_id, []), ["AccusedMasterID"])
        victim_rows = sorted_rows(victims_by_case.get(case_id, []), ["VictimMasterID"])
        complainant_rows = sorted_rows(complainants_by_case.get(case_id, []), ["ComplainantID"])
        chargesheet_rows = sorted_rows(chargesheets_by_case.get(case_id, []), ["CSID"])
        arrest_rows = arrests_by_case.get(case_id, [])
        act_section_rows = sorted_rows(
            act_sections_by_case.get(case_id, []),
            ["ActOrderID", "SectionOrderID"],
        )

        act_names: list[str] = []
        section_names: list[str] = []
        for row in act_section_rows:
            act_code = clean(row.get("ActID") or row.get("ActCode"))
            section_code = clean(row.get("SectionID") or row.get("SectionCode"))
            act_row = acts.get(act_code)
            section_row = sections.get((act_code, section_code)) or sections.get(("", section_code))
            act_names.append(display(act_row, ["ShortName", "ActDescription", "ActCode"]) or act_code)
            section_names.append(
                display(section_row, ["SectionDescription", "SectionCode"]) or section_code
            )

        record = {header: "" for header in CSV_HEADERS}
        record.update(
            {
                "CaseMasterID": case_id,
                "CrimeNo": clean(case.get("CrimeNo")),
                "CaseNo": clean(case.get("CaseNo")),
                "CrimeRegisteredDate": clean(case.get("CrimeRegisteredDate")),
                "CrimeHead": display(
                    crime_heads.get(intish(case.get("CrimeMajorHeadID", ""))),
                    ["CrimeGroupName", "CrimeHeadName", "LookupValue"],
                ),
                "CrimeSubHead": display(
                    crime_subheads.get(intish(case.get("CrimeMinorHeadID", ""))),
                    ["CrimeHeadName", "CrimeSubHeadName", "LookupValue"],
                ),
                "PoliceStation": display(station, ["UnitName", "PoliceStationName", "StationName"]),
                "PoliceStationType": display(
                    unit_types.get(intish(station_type_id)),
                    ["UnitTypeName", "TypeName", "LookupValue"],
                ),
                "District": display(
                    districts.get(intish(case.get("DistrictID", "")))
                    or districts.get(intish(station.get("DistrictID", "")) if station else ""),
                    ["DistrictName", "LookupValue"],
                ),
                "Court": display(courts.get(intish(case.get("CourtID", ""))), ["CourtName", "LookupValue"]),
                "EmployeeID": intish(case.get("PolicePersonID", "")),
                "Officer": display(employee, ["FirstName", "OfficerName", "EmployeeName"]),
                "OfficerRank": display(rank, ["RankName", "LookupValue"]),
                "OfficerDesignation": display(designation, ["DesignationName", "LookupValue"]),
                "Status": display(
                    statuses.get(intish(case.get("CaseStatusID", ""))),
                    ["CaseStatusName", "LookupValue"],
                ),
                "CaseCategory": display(
                    categories.get(intish(case.get("CaseCategoryID", ""))),
                    ["LookupValue", "CaseCategoryName"],
                ),
                "Gravity": display(
                    gravities.get(intish(case.get("GravityOffenceID", ""))),
                    ["LookupValue", "GravityOffenceName"],
                ),
                "AccusedCount": str(len(accused_rows)),
                "AccusedNames": "; ".join(clean(row.get("AccusedName")) for row in accused_rows if clean(row.get("AccusedName"))),
                "VictimCount": str(len(victim_rows)),
                "VictimNames": "; ".join(clean(row.get("VictimName")) for row in victim_rows if clean(row.get("VictimName"))),
                "Complainant": "; ".join(
                    clean(row.get("ComplainantName"))
                    for row in complainant_rows
                    if clean(row.get("ComplainantName"))
                ),
                "ArrestCount": str(len(arrest_rows)),
                "ChargesheetCount": str(len(chargesheet_rows)),
                "LatestChargesheetDate": latest_text(row.get("csdate") for row in chargesheet_rows),
                "ChargesheetStatus": "Filed" if chargesheet_rows else "Pending",
                "Acts": join_unique(act_names),
                "Sections": join_unique(section_names),
                "InfoReceivedPSDate": clean(case.get("InfoReceivedPSDate")),
                "IncidentFromDate": clean(case.get("IncidentFromDate")),
                "IncidentToDate": clean(case.get("IncidentToDate")),
                "Latitude": clean(case.get("latitude") or case.get("Latitude")),
                "Longitude": clean(case.get("longitude") or case.get("Longitude")),
                "BriefFacts": clean(case.get("BriefFacts")),
            }
        )
        flat_cases.append(record)

    return flat_cases


def write_cases(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    with temp_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_HEADERS)
        writer.writeheader()
        writer.writerows(rows)
    temp_path.replace(path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Pull Google Master Sheet data into Consolidated_Cases.csv.")
    parser.add_argument(
        "--output",
        default=os.getenv("PULL_OUTPUT_CSV", os.getenv("CONSOLIDATED_CASES_CSV", str(DEFAULT_CSV_PATH))),
        help="Output CSV path",
    )
    parser.add_argument(
        "--spreadsheet-id",
        default=os.getenv("GOOGLE_SHEET_ID", DEFAULT_SPREADSHEET_ID),
        help="Google Sheets spreadsheet ID",
    )
    parser.add_argument("--dry-run", action="store_true", help="Read and build the CSV without writing it.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    token = service_account_token()
    tables = read_master_tables(args.spreadsheet_id, token)
    rows = build_flat_cases(tables)
    if not rows:
        raise RuntimeError("No CaseMaster rows were found in the Google Master Sheet.")

    if args.dry_run:
        print(f"Read {len(rows)} cases from Google Master Sheet. No local CSV was written.")
        return 0

    output = Path(args.output)
    write_cases(output, rows)
    print(f"Pulled {len(rows)} cases from Google Master Sheet into {output}.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"export_data.py failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
