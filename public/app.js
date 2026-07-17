// ============================================================
// 1. API & AUTH HELPERS – SERVER INTEGRATION
// ============================================================
const API_BASE = 'https://qa-qc-enterprise.onrender.com';
// ⬇️ PASTE THE STUBS RIGHT HERE ⬇️
function renderRfiChart(type) {
  console.log('RFI chart placeholder');
}
function renderHistory() {
  console.log('History placeholder');
}
function updateStats() {
  console.log('Stats placeholder');
}
async function apiRequest(url, options = {}) {
  const token = localStorage.getItem('token');
  if (!token) throw new Error('Not authenticated');
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
    'Authorization': `Bearer ${token}`
  };
  const res = await fetch(`${API_BASE}${url}`, { ...options, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error('401 Unauthorized');
    throw new Error(err.error || 'API error');
  }
  return res.json();
}
// ============================================================
// PUSH NOTIFICATIONS – SUBSCRIPTION
// ============================================================

// Helper: convert VAPID public key from base64 to Uint8Array
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
// Fetch all approved users of a specific role
async function getUsersByRole(role) {
  return await apiRequest(`/api/users/role/${role}`);
}
// Subscribe to push notifications
async function subscribeToPush() {
  try {
    const registration = await navigator.serviceWorker.ready;
    const VAPID_PUBLIC_KEY = 'BHzbOyM647Z8uN1xLiWNeONBNd0PP0zSRBEhWeebb6klyAGzzpm4snfC1dzmB6ZTS8UF7bljJrHDYA2SxdbehJo';   // <-- REPLACE THIS
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
    });
    await apiRequest('/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({ subscription })
    });
    console.log('✅ Push subscription saved');
  } catch (error) {
    console.warn('❌ Push subscription failed:', error);
  }
}
// ============================================================
// 2. DATA LAYER (localStorage cache + server as source of truth)
// ============================================================
const STORAGE_KEY = 'qaqc_suite_data_v2';
const CONFIG_KEY = 'qaqc_suite_config_v2';
const MASTER_KEY = 'qaqc_suite_masters_v2';
const NOTIFICATION_KEY = 'qaqc_suite_notifications_v2';
const SESSION_KEY = 'qaqc_session_v2';
let savedReports = [];
let appConfig = { companyName: 'QA/QC Suite', projectName: 'Project Name', location: 'Location', formatPrefix: 'QA / QC', businessPackage: 'Site Formats', ncrCounter: 1, imirCounter: 1 };
let currentUser = null;
let activeTemplateKey = null;
let activeReportId = null;
let previousView = 'dashboard';
let pendingReturnRfiId = null;
let pendingLinkedRfiNo = null;
let pendingParentMeta = null;
let currentKpiFilter = 'total';
let currentKpiRows = [];
let globalFilterState = { project: '', type: '', contractor: '', discipline: '', status: '', fromDate: '', toDate: '', owner: '' };
let notifications = [];
let notificationPollInterval = null;
let agencyUsers = [];   // ← ADD THIS
let allUsersCache = []; // Stores all users from server
// Debounce helper – delays function execution until after user stops typing
function debounce(func, delay = 300) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), delay);
  };
}
// Toggle sidebar for mobile
function toggleSidebar() {
  const sidebar = document.querySelector('.sidebar');
  if (sidebar) {
    sidebar.classList.toggle('open');
  }
}

function isNcr() { return activeTemplateKey === 'ncr'; }
function isRfi() { return activeTemplateKey === 'rfi'; }
function isImir() { return activeTemplateKey === 'imir'; }
function isAudit() { return activeTemplateKey === 'audit'; }  

// ============================================================
// 3. FIELD MAPPING HELPERS
// ============================================================
function getUserDefaultSite() {
  if (currentUser && currentUser.assigned_sites && currentUser.assigned_sites.length > 0) {
    return currentUser.assigned_sites[0];
  }
  return 'Default';
}

function toApiPayload(row, siteName) {
  return {
    id: row.id,
    template_key: row.templateKey,
    template_name: row.templateName,
    format_no: row.formatNo,
    meta: row.meta || {},
    sections: row.sections || [],
    score: row.score || 0,
    defects_count: row.defectsCount || 0,
    title_loc: row.titleLoc || '',
    prepared_by: row.preparedBy || '',
    status: row.status || 'Draft',
    comment: row.comment || '',
    attachments: row.attachments || [],
    decision_by: row.decisionBy || '',
    decision_by_display: row.decisionByDisplay || '',
    raised_from_rfi: row.raisedFromRfi || '',
    site_name: siteName
  };
}

// ============================================================
// 4. TEMPLATES – COPY ALL YOUR ORIGINAL TEMPLATES HERE (unchanged)
// ============================================================
const templates = {
  rfi: {
    formatNo: 'QA / QC / SITE / 01',
    menuTitle: 'RFI',
    title: 'REQUEST FOR INSPECTION',
    dept: 'QA / QC RECORDS FOR SITE',
    summary: 'Standard RFI with workflow and approvals.',
    metaRows: [
      [{ l: 'Project :-', k: 'project', d: 'Project Name' }, { l: 'RFI No.:', k: 'rfiNo' }],
      [{ l: 'Package :-', k: 'package' }, { l: 'RFI Rev.No.:', k: 'rfiRev' }],
      [{ l: 'Contractor :-', k: 'contractor' }, { l: 'Discipline :', k: 'discipline' }],
      [{ l: 'Project Code :-', k: 'projectCode' }],
      [{ l: 'DRAWING NO.:', k: 'drawingNo' }, { l: 'DATE OF ISSUE :', k: 'issueDate', t: 'date' }],
      [{ l: 'EQUIPMENT / ITEM No :', k: 'itemNo' }, { l: 'FQA REF :', k: 'fqaRef' }],
      [{ l: 'EQUIPMENT / ITEM NAME :', k: 'itemName' }],
      [{ l: 'ATTACHMENTS :', k: 'attachments' }],
      [{ l: 'Inspection Type :', k: 'inspectionType', t: 'select', options: ['Material Inspection', 'Work Inspection'] }, { l: 'Raised By :', k: 'raisedBy' }],
      [{ l: 'Inspection Date', k: 'date', t: 'date' }, { l: 'Inspection Location/Area', k: 'location' }],
      [{ l: 'Inspection to be done', k: 'inspectionScope' }],
      [{ l: 'Routing :', k: 'routing', t: 'radio', options: ['Direct to QA Head', 'Execution Engineer → QA Head', 'Both'] }]
    ],
    sections: [
      { type: 'simple_check', title: 'Contractor / Company Check Requirements', items: ['Hold', 'Witness', 'Review/Sur.'] },
      { type: 'table', title: 'Offer Detail', columns: ['Sl no', 'Description', 'Weight / Qty', 'Remarks'], rows: 5 },
      { type: 'accepted', title: 'Work Accepted by', rows: ['Contractor/Execution', 'Company/Execution'] },
      { type: 'status', title: 'INSPECTION STATUS', options: ['Accepted', 'Not Accepted', 'Accepted with comments', 'Reviewed'] },
      { type: 'textarea', title: 'Remarks/Comments', note: 'Write general comments only.' },
      { type: 'signatures', title: 'Signature Block', roles: ['Contractor QA/QC', 'Company FQA', 'Company QA/QC'] }
    ]
  },
  brick_masonry: {
    formatNo: 'QA / QC / SITE / 02',
    menuTitle: 'Brick Masonry',
    title: 'CHECK LIST FOR BRICK MASONRY WORK',
    dept: 'QA / QC RECORDS FOR SITE',
    summary: 'Brick masonry checklist with manual fields and linked RFI support.',
    metaRows: [
      [{ l: 'Linked RFI No :', k: 'linkedRfi', t: 'select', options: [] }],
      [{ l: 'Project :-', k: 'project', d: 'Project Name' }, { l: 'Name of Building / Structure :', k: 'building' }],
      [{ l: 'Package :-', k: 'package' }],
      [{ l: 'Contractor :-', k: 'contractor' }, { l: 'Location of Wall :', k: 'wallLocation' }],
      [{ l: 'Project Code :-', k: 'projectCode' }],
      [{ l: 'Date:-', k: 'date', t: 'date' }, { l: 'Mix Proportion Mortar:-', k: 'mixProportion' }]
    ],
    sections: [
      { type: 'checklist', columns: ['Sr. No.', 'Description', 'Status', 'Remarks'], groups: [
        { name: 'PRE-BRICK WORK', items: ['Cleaning of work area', 'Check for Marking', 'Check for scaffolding', 'Hacking & curing compound removal', 'Sprinkling of water', 'Bricks soaked for 24 hours', 'Platform for mixing', 'Mortar Mix Proportion'] },
        { name: 'DURING BRICK WORK', items: ['Wall sizes & thickness', 'Dimension, Plumb & Level', 'Type of Bond', 'Staggering of Joints', 'Sizes of Openings', 'Cleaning & Raking of Joints', 'Mortar consumption within 30 min'] },
        { name: 'POST BRICK WORK', items: ['Sufficient Curing (7 days)', 'Pointing balance', 'Removal of Debris', 'Cube Samples Collected'] }
      ]},
      { type: 'textarea', title: 'Conclusion by Observation Officer', note: 'Released / Not Released for Plaster' },
      { type: 'signatures', title: 'Signatures', roles: ['Contractor Representative', 'Client Representative'] }
    ]
  },
  plaster_work: {
    formatNo: 'QA / QC / SITE / 04',
    menuTitle: 'Plaster Work',
    title: 'CHECK LIST FOR PLASTER WORK',
    dept: 'QA / QC RECORDS FOR SITE',
    summary: 'Plaster work checklist with manual fields and linked RFI support.',
    metaRows: [
      [{ l: 'Linked RFI No :', k: 'linkedRfi', t: 'select', options: [] }],
      [{ l: 'Project :-', k: 'project', d: 'Project Name' }, { l: 'Name of Building / Structure :', k: 'building' }],
      [{ l: 'Package :-', k: 'package' }],
      [{ l: 'Contractor :-', k: 'contractor' }, { l: 'Location of Wall :', k: 'wallLocation' }],
      [{ l: 'Project Code :-', k: 'projectCode' }],
      [{ l: 'Date:-', k: 'date', t: 'date' }, { l: 'Plaster :-', k: 'plasterType', t: 'select', options: ['External', 'Internal'] }],
      [{ l: 'Mix Proportion Mortar:-', k: 'mixProportion' }]
    ],
    sections: [
      { type: 'checklist', columns: ['Sr. No.', 'Description', 'Status', 'Remarks'], groups: [
        { name: 'PRE-PLASTER', items: ['Completion of Preceding activities', 'Cleaning of work area', 'Scaffolding safety', 'Hacking & curing compound removal', 'Sprinkling of water', 'Type of plastering', 'Platform for mixing', 'Measuring boxes', 'Wire mesh at critical joints'] },
        { name: 'DURING PLASTER WORK', items: ['Mortar Mix Proportion', 'Waterproofing compound', 'Ceiling plaster prior to wall', 'Rough surface on first coat', 'Second coat timing', 'Thickness of plaster', 'Dimension, plumb & level'] },
        { name: 'POST PLASTER WORK', items: ['7 days of curing', 'Removal of debris', 'Cube samples collected'] }
      ]},
      { type: 'signatures', title: 'Signatures', roles: ['Contractor Representative', 'Client Representative'] }
    ]
  },
  concrete_pour_record: {
    formatNo: 'QA / QC / SITE / 09',
    menuTitle: 'Concrete Pour Record',
    title: 'CONCRETE POUR RECORD',
    dept: 'QA / QC RECORDS FOR SITE',
    summary: 'Concrete pour record sheet with manual fields and linked RFI support.',
    metaRows: [
      [{ l: 'Linked RFI No :', k: 'linkedRfi', t: 'select', options: [] }],
      [{ l: 'Structure', k: 'structure' }, { l: 'Date of Pouring', k: 'date', t: 'date' }],
      [{ l: 'Location', k: 'location' }, { l: 'Method of Pouring', k: 'method' }],
      [{ l: 'Part of Structure', k: 'partOfStructure' }, { l: 'Qty.Required', k: 'qtyRequired' }],
      [{ l: 'Grade of Concrete', k: 'grade' }, { l: 'Ambient Temp. (°C)', k: 'ambientTemp' }],
      [{ l: 'Project', k: 'project', d: 'Project Name' }, { l: 'Contractor', k: 'contractor' }],
      [{ l: 'Prepared By', k: 'preparedBy' }]
    ],
    sections: [
      { type: 'table', title: 'Concrete Pour Record', columns: ['Sl.no', 'T.M.no.', 'Dep. Time', 'Slump at BP', 'Arrival', 'Slump at site', 'Pour start', 'Pour end', 'Qty(cum)', 'Cumulative', 'Remarks'], rows: 10 },
      { type: 'signatures', title: 'Signatures', roles: ['Contractor Representative', 'Client Representative'] }
    ]
  },
  ncr: {
    formatNo: 'ADANI/Q/F-09 Rev 0',
    menuTitle: 'NCR',
    title: 'NON CONFORMANCE REPORT',
    dept: '(Issued by QA/FQA to respective agency)',
    summary: 'Non‑Conformance Report (NCR) issued by QA/FQA to respective agency.',
    metaRows: [
      [{ l: 'NCR No.:', k: 'ncrNo' }, { l: 'Category:', k: 'category' }],
      [{ l: 'Project Name:', k: 'project', d: 'Project Name' }, { l: 'Entity Type:', k: 'entityType' }],
      [{ l: 'Package:', k: 'package' }, { l: 'Agency:', k: 'agency' }],
      [{ l: 'WBS Code:', k: 'wbsCode' }, { l: 'Location:', k: 'location' }],
      [{ l: 'PO/SO Name:', k: 'poSoName' }, { l: 'Discipline:', k: 'discipline' }],
      [{ l: 'PO/SO No.:', k: 'poSoNo' }, { l: 'NCR Date:', k: 'ncrDate', t: 'date' }],
      [{ l: 'PO/SO Date:', k: 'poSoDate', t: 'date' }, { l: 'Material/Service:', k: 'materialService' }],
      [{ l: 'Severity:', k: 'severity', t: 'select', options: ['Major', 'Minor', 'Critical'] }, { l: 'Responsible:', k: 'responsible' }]
    ],
    sections: [
      { type: 'table', title: 'Description of Material', columns: ['Description of Material', 'ID/ Tag', 'Quantity', 'UoM'], rows: 4 },
      { type: 'textarea', title: 'Description of Non Conformance (NC) (Attach Spec/ Drawings, if required)' },
      { type: 'textarea', title: 'Root Cause' },
      { type: 'textarea', title: 'Engineering Recommendation' },
      { type: 'textarea', title: 'Proposed Corrections' },
      { type: 'status', title: 'Type', options: ['Repair', 'Rework', 'Reject', 'Concession'] },
      { type: 'textarea', title: 'Proposed Corrective Actions' },
      { type: 'date', title: 'Target Date', k: 'targetDate' },
      { type: 'signatures', title: 'Originated by', roles: ['Name', 'Signature', 'Date'] },
      { type: 'signatures', title: 'Adani Responsible (Engg./Const.)', roles: ['Name', 'Signature', 'Date'] },
      { type: 'signatures', title: 'Area/Discipline Lead', roles: ['Name', 'Signature', 'Date'] },
      { type: 'signatures', title: 'Received by', roles: ['Name', 'Signature', 'Date'] },
      { type: 'textarea', title: 'NC Disposal Summary' },
      { type: 'textarea', title: 'Verification of Corrective Action' },
      { type: 'text', title: 'Code', k: 'code' },
      { type: 'signatures', title: 'Disposal Approved by', roles: ['Name', 'Signature', 'Date'] }
    ]
  },
  imir: {
    formatNo: 'QA/QC/IMIR-01',
    menuTitle: 'IMIR',
    title: 'MATERIAL APPROVAL',
    dept: '',
    summary: 'Material Approval Submittal (IMIR) for client approval.',
    metaRows: [
      [{ l: 'Client:', k: 'client', d: 'M/s Adani Entreprises Ltd' }, { l: 'Package/System:', k: 'package' }],
      [{ l: 'Location:', k: 'location' }, { l: 'Date :', k: 'date', t: 'date' }],
      [{ l: 'Drawing No.:', k: 'drawingNo' }, { l: 'Status:', k: 'status', t: 'select', options: ['Approved (A)', 'Approved As Noted (B)', 'Not Approved (C)'] }],
      [{ l: 'To:', k: 'to', d: 'FQA Head Adani' }, { l: 'Subject:', k: 'subject' }]
    ],
    sections: [
      { type: 'table', title: 'Material Submittal List', columns: ['Sl. No', 'Material Description', 'Manufacturer', 'Supplier', 'Structure of Indent use', 'Status (A/B/C)'], rows: 5 },
      { type: 'textarea', title: 'Relevant Drawing:-' },
      { type: 'textarea', title: 'Relevant Specification No.:-' },
      { type: 'textarea', title: 'Remarks' },
      { type: 'signatures', title: 'Signatory', roles: ['Merit Execution', 'Merit QA/QC', 'Adani Execution', 'Adani FQA', 'Adani QA/QC'] }
    ]
  },
 audit: {
  formatNo: 'AUDIT / QA / 001',
  menuTitle: 'Project Audit',
  title: 'PROJECT AUDIT REPORT',
  dept: 'QA / QC AUDIT RECORDS',
  summary: 'Project Audit Report with 56 checkpoints.',
  metaRows: [
    [{ l: 'Report No:', k: 'reportNo' }],
    [{ l: 'Project:', k: 'project' }, { l: 'Audit Date :', k: 'auditDate', t: 'date' }],
    [{ l: 'Client:', k: 'client' }, { l: 'Auditor:', k: 'auditor' }],
    [{ l: 'Consultant:', k: 'consultant' }, { l: 'Nature Of Contractor:', k: 'contractorNature' }],
    [{ l: 'Project Value:', k: 'projectValue' }, { l: 'Assessment dates:', k: 'assessmentDates' }],
    [{ l: 'Client address:', k: 'clientAddress' }, { l: 'Reporting dates:', k: 'reportingDates' }],
    [{ l: 'Assessment team:', k: 'assessmentTeam' }, { l: 'Assessment criteria:', k: 'assessmentCriteria' }]
  ],
  sections: [
    {
      type: 'audit_table',
      title: 'Project Audit Checklist',
      columns: ['sr no', 'Tasks', 'Available (Y/N)', 'Documents(Y/N)', 'satisfactory/ Unsatisfactory', 'Remarks'],
      rows: [
        'Tender’s Technical Documents, LOA, LOI & Kick off Meeting agenda & MOM.',
        'Management Objectives / Quality Objectives. if any.',
        'Project Quality Plan & Master List of Document / Record',
        'Project Organogram.',
        'Project Construction schedule & Milestone details',
        'Drawing Control System and as built Drawing, if any.',
        'Materials / Equipment / Items Source Approval Record',
        'Approved Vendor List, Approved Subcontractor List, Approved Materials / item list.',
        'Procurement Tracker',
        'Vender & Sub-Contractors Evaluation / Appraisal Record',
        'Client / EPC Correspondence Inward & Outward record system',
        'Relevant IS Codes, Technical Specification, Approved Drawing, Relevant Standards & Standard operating procedures (SOPs), if any.',
        'Approved Standard Quality Plan, Manufacturing Quality Plan, Field Quality Plan, Inspection and Test Plan, Technical Specification, Method Statement - Activity Wise, Checklists & related Formats etc, & Awareness about the same.',
        'Check whether approved Work method statement depicts the process of construction/activity',
        'Check / Review on calibration of all weight & measures, laboratory’s apparatus, Plant’s (Batching plant, Wet mix plant, Hot mix plant, if any), Equipment etc and maintaining related Assurance documents as well calibration log.',
        'Material receival Record & Incoming materials register.',
        'Request for Inspection (RFI) for Materials, Equipment, Semi Product & Finished Product etc & their log.',
        'Materials sampling Register & their reports.',
        'Perishable item register & FIFO (first in first out) system.',
        'Material Traceability / identification tags',
        'Approved Materials / Equipment / Item (Category Wise): IR / MDCC / IMIR Certificate / MTC and other relevant assurance documents.',
        'Check whether site engineer is aware about the resources required for activity as well availability of the same at work site.',
        'Raw materials, Semi & Finished Product Check as per Approved QAP/ITP, Procedure, Standards etc & Inspection Report of the same (Inhouse or & Third-Party Test Report).',
        'Check the frequency of tests conducted as per the approved ITP, QAP and specifications.',
        'For Special Tests, which cannot be performed at site/ field lab, shall be carried out at mutually agreed laboratory.',
        'TBM periodic level checking records as well check other survey documents like level sheet etc.',
        'Bar Bending Schedule',
        'Approved Mix Design / Job Mix Formula Report & moisture correction sheet',
        'Plant Production report - Planned Vs Actual.',
        'Welder Qualification procedure & List of Qualified Welder & Certified NDT Technician.',
        'Approved SOP / Protocol for NDT test (Refer ASME Sec V, VIII & IX)',
        'Approved WPS (Welder Procedure Specification), PQR and WPQ shall be reviewed.',
        'Welder Certificate I card shall be reviewed.',
        'Structural welding details to be checked as per approved drawing.',
        'Filled weld thickness to be verified randomly.',
        'Painting DFT must be cross verified at site.',
        'Mock-up/workshop conducted before start of activity. If yes, review the mock-up report.',
        'Checking all the Stage Passes with all the QA documents as per specification i.e., for structures like reinforcement checking, pre, during & post concrete check, compressive strength check at 7 & 28 days and for roads layer like Embankment top, Subgrade top, GSB top, WMM top, DBM top, wearing course and for structural work: Materials receival, Traceability Report, Storage /Handling condition, Cutting, fit up check, Welding & fabrication, shot blasting, Painting.',
        'Curing tank temperature register & Weather Report Register',
        'Mechanical & Electrical Equipment / items must be check thoroughly as per Approved SQP/FQP/ MQP/ITP/Approved Drawing.',
        'Product Quality Checks as per approved standard & specification',
        'RFI Details Status Summary: Approved / Approved with Deviation / Rejected RFI with Supporting Documents',
        'Does Project site team periodically analyse the results obtained from post construction inspection. If yes, Check the action taken based on the analysis.',
        'Non-Compliance, Observations & Punch Point records as well Compliance Report.',
        'Customer Complaints Record, Repair & Rework Record',
        'Monthly Quality Review Report, Customer Satisfaction Report',
        'Project Progress Report – Daily, Weekly & Monthly and Delay analysis report, if any',
        'Periodic Maintenance record of construction equipment / Machine etc & Breakdown report, if any',
        'Rejected & surplus material / items detail Record.',
        'Physical v/s System stock, Monthly stock statement & Materials reconciliation statement.',
        'Machine / Equipment / Items Handling & Storage as per Requirement.',
        'Risk Review Assessment Record, Statutory compliance',
        'Training calendar & records, evaluation sheet & Effectiveness of the training',
        'Best Practices Initiated / Value Engineering done, if any, Identified Area for Improvement',
        'Previous Audit Closure Report.',
        'Structure Handing over Record & Final Project Dossiers, if any.'
      ]
    },
    { type: 'textarea', title: 'Project Description' },
    { type: 'textarea', title: 'Areas of Appreciation:' },
    { type: 'textarea', title: 'Non-Compliance VS Compliance' },
    { type: 'signatures', title: 'Audit Signatures', roles: ['Auditor', 'Project Manager', 'QA Head'] }
  ]
},
  compliance_report: {
  formatNo: 'COMPLIANCE / CAPA / 01',
  menuTitle: 'Compliance Report',
  title: 'COMPLIANCE REPORT (PART OF CAPA)',
  dept: 'TECHNICAL AUDIT COMPLIANCE',
  summary: 'Compliance Report linked to Technical Audit with NCR details, corrections, and images.',
  metaRows: [
    [{ l: 'Linked Audit Report:', k: 'linkedAudit', t: 'select', options: [] }],
    [{ l: 'Project:', k: 'project', d: 'Project Name' }, { l: 'Audit Conducted By:', k: 'auditor' }],
    [{ l: 'Audit Conducted From:', k: 'auditFrom', t: 'date' }, { l: 'Audit Conducted To:', k: 'auditTo', t: 'date' }],
    [{ l: 'Audit Report No.:', k: 'auditReportNo' }, { l: 'Auditor Name:', k: 'auditorName' }]
  ],
  sections: [
    {
      type: 'compliance_table',
      title: 'Compliance Report (Part of CAPA)',
      columns: [
        'Sr. No.',
        'NCR Nos. (With Details)',
        'Description',
        'Image (Before Correction)',
        'Severity',
        'Frequency',
        'Requirement',
        'Root Cause',
        'Correction',
        'Image (After Correction)',
        'Corrective Action',
        'Remarks'
      ],
      rows: 25 // 25 rows as per your Excel
    },
    {
      type: 'textarea',
      title: 'Our Commitment',
      note: 'To deliver cost effective defect free Quality product in time with utmost customer satisfaction along with the first-time right work concept.'
    },
    { type: 'signatures', title: 'Signatures', roles: ['Prepared By', 'Reviewed By', 'Approved By'] }
  ]
}
};   
  // ============================================================
// activity CHECKLIST DATA (from "Total Number of checks" sheet)
// ============================================================
const activityChecklists = [
  {
    key: 'activity_painting',
    title: 'Painting Checklist',
    formatNo: 'activity / PAINT / 01',
    items: [
      'Walls & Ceilings - 7 checks',
      'Tilling - 39 checks',
      'Door & Windows - 26 checks',
      'Lofts - 7 checks',
      'Plumbing & Sanitation - 26 checks',
      'Electrification - 18 checks',
      'Painting - 7 checks',
      'Rolling shutter - 13 checks',
      'Total A - 143 checks',
      'Development work of building - 16 checks',
      'Terrace or Roof - 16 checks',
      'Building Exterior & General - 34 checks',
      'Structural steel - 4 checks',
      'Total B - 54 checks'
    ]
  },
  {
    key: 'activity_door_frames',
    title: 'Door Frames & Shutters',
    formatNo: 'activity / DOOR / 02',
    items: [
      'Architectural drawings & section details',
      'Approved work method statement',
      'Checklist for activity',
      'Inspection test plan for materials',
      'Mock-up approval sheet with hardware',
      'Compliance to test results as per ITP',
      'Material storage as per guidelines',
      'Material approval sheet duly signed',
      'Reliability test reports',
      'MTC reviewed & signed by QC manager',
      'Adherence to sequence of activities',
      'Adequate tools for checking workmanship',
      'Adequate protection of finish product',
      'Dimensions (L, B, H) as per drawings',
      'Plumb maintained for side jambs',
      'Frame is in right angles',
      'Uniformity of Paint / Polish work',
      'Gap along frame & opening sealed',
      'Architrave fixed & finished properly',
      'Location of shutter fittings as per sample',
      'Proper orientation of hinges',
      'Functionality & rigidity of fittings',
      'Surface defects (dents, scratches, stains)'
    ]
  },
  {
    key: 'activity_tiling',
    title: 'Tiling Works (Wall & Dado)',
    formatNo: 'ACTIVITY REQUIRED / TILE / 03',
    items: [
      'Architectural drawings showing tile layout',
      'Approved shop drawings for each typology',
      'Approved method statement for tiling works',
      'Checklist for tiling works',
      'Activity covered under QEP',
      'Mock-up approval sheet duly signed',
      'Field, Physical, Chemical test for tiles',
      'MTC and Lab. test reports reviewed',
      'Tiles stored as per guidelines',
      'Material approval sheet for tiles & adhesive',
      'Approved tile base samples stored',
      'Dry laying done for checking layout',
      'Soaking of tiles in water (except vitrified)',
      'Adherence to sequence of activities',
      'Tools for working & inspection available',
      'Protection done using bubble wrap sheet',
      'Extra tiles kept for future replacement (min 5%)',
      'Line, level & Slope of finished surface',
      'Flatness & Evenness',
      'Lippage in between two tiles',
      'Right angle to adjacent wall',
      'Thickness of skirting at edges & corners',
      'Hollowness in tiles (no hollowness at centre)',
      'Matching of joints in dado / skirting & floor',
      'Joints and grouting uniform & clean',
      'Silicon sealant applied in wet areas',
      'Pull-off test satisfactory for wall tiles'
    ]
  }
  // ★ You can add the remaining 13 checklists here later (I'll give them in Step 2)
];
 // ============================================================
// GENERATE activity CHECKLIST TEMPLATES DYNAMICALLY
// ============================================================
activityChecklists.forEach(hc => {
  templates[hc.key] = {
    formatNo: hc.formatNo,
    menuTitle: hc.title,
    title: hc.title.toUpperCase(),
    dept: 'ACTIVITY REQUIRED QUALITY CHECKLIST',
    summary: 'activity quality checklist for ' + hc.title,
    metaRows: [
      [{ l: 'Linked Audit Report:', k: 'linkedAudit', t: 'select', options: [] }],
      [{ l: 'Project:', k: 'project', d: 'Project Name' }, { l: 'Audit Date:', k: 'date', t: 'date' }],
      [{ l: 'Contractor:', k: 'contractor' }, { l: 'Location:', k: 'location' }]
    ],
    sections: [
      {
        type: 'activity_checklist',
        title: hc.title + ' Checklist',
        items: hc.items
      },
      { type: 'textarea', title: 'Remarks / Comments' },
      { type: 'signatures', title: 'Signatures', roles: ['Contractor QA/QC', 'Company QA/QC', 'QA Head'] }
    ]
  };
}); 
// ============================================================
// 5. EXACT EXCEL REPLICA RENDERING – COPY YOUR ORIGINAL CODE
// (ev, secVal, rowVals, signEntries, inputExact, textExact,
// renderNCRExact, renderIMIRExact, collectNCRSectionsExact,
// collectIMIRSectionsExact – all unchanged)
// ============================================================
function ev(v) { return esc(v || ''); }
function secVal(report, idx, fallbackKey) {
  const sec = (report?.sections || [])[idx] || {};
  if (sec.value !== undefined) return sec.value;
  if (fallbackKey && sec[fallbackKey] !== undefined) return sec[fallbackKey];
  return '';
}
function rowVals(report, idx, rowCount, colCount) {
  const rows = ((report?.sections || [])[idx] || {}).rows || [];
  const out = [];
  for (let r = 0; r < rowCount; r++) {
    const row = rows[r] || [];
    out.push(Array.from({length: colCount}, (_, c) => row[c] ?? (c === 0 ? String(r + 1) : '')));
  }
  return out;
}
function signEntries(report, idx, roles) {
  const entries = ((report?.sections || [])[idx] || {}).entries || [];
  return roles.map((role, i) => ({ role, ...(entries[i] || {}) }));
}
function inputExact(id, value, type='text', options=[]) {
  if (type === 'select') {
    return `<select id="${id}" class="exact-select">${options.map(o => `<option value="${ev(o)}" ${String(value)===String(o)?'selected':''}>${ev(o)}</option>`).join('')}</select>`;
  }
  return `<input ${id ? `id="${id}"` : ''} type="${type}" class="exact-input" value="${ev(value)}">`;
}
function textExact(key, value, cls='') {
  return `<textarea data-exact-text="${key}" class="exact-textarea ${cls}">${ev(value)}</textarea>`;
}
function renderNCRExact(report) {
  const m = report?.meta || {};
  const typeValue = secVal(report, 5);
  const materialRows = rowVals(report, 0, 4, 4);
  const sigRoles = ['Originated by', 'Adani Responsible<br>(Engg./Const.)', 'Area/Discipline Lead', 'Received by:'];
  const sigs = [8,9,10,11].map((idx, i) => signEntries(report, idx, [''])[0] || {});
  const dispSig = signEntries(report, 15, ['Disposal Approved by:'])[0] || {};
  return `
  <div class="exact-format ncr-exact">
    <table class="exact-table">
      <tr><th colspan="4" class="exact-main-title">Non Conformance Report (NCR)</th></tr>
      <tr><th colspan="4" class="exact-sub-title">(Issued by QA/FQA to respective agency)</th></tr>
      <tr><td class="exact-label">NCR No.:</td><td>${inputExact('meta_ncrNo', m.ncrNo)}</td><td class="exact-label">Category:</td><td>${inputExact('meta_category', m.category)}</td></tr>
      <tr><td class="exact-label">Project Name:</td><td>${inputExact('meta_project', m.project || appConfig.projectName)}</td><td class="exact-label">Entity Type:</td><td>${inputExact('meta_entityType', m.entityType)}</td></tr>
      <tr>
  <td class="exact-label">Package:</td>
  <td>${inputExact('meta_package', m.package)}</td>
  <td class="exact-label">Agency:</td>
<td>
  <div class="exact-radio-line" style="display:flex; flex-wrap:wrap; gap:8px;">
   ${generateAgencyRadios(m.agency, 'checkbox')}
  </div>
  </td>
</tr>
      <tr><td class="exact-label">WBS Code:</td><td>${inputExact('meta_wbsCode', m.wbsCode)}</td><td class="exact-label">Location:</td><td>${inputExact('meta_location', m.location || appConfig.location)}</td></tr>
      <tr><td class="exact-label">PO/SO Name:</td><td>${inputExact('meta_poSoName', m.poSoName)}</td><td class="exact-label">Discipline:</td><td>${inputExact('meta_discipline', m.discipline)}</td></tr>
      <tr><td class="exact-label">PO/SO No.:</td><td>${inputExact('meta_poSoNo', m.poSoNo)}</td><td class="exact-label">NCR Date:</td><td>${inputExact('meta_ncrDate', m.ncrDate, 'date')}</td></tr>
      <tr><td class="exact-label">PO/SO Date:</td><td>${inputExact('meta_poSoDate', m.poSoDate, 'date')}</td><td class="exact-label">Material/ Service:</td><td>${inputExact('meta_materialService', m.materialService)}</td></tr>
      <tr><td class="exact-label">Severity:</td><td>${inputExact('meta_severity', m.severity, 'select', ['Major','Minor','Critical'])}</td><td class="exact-label">Responsible:</td><td>${inputExact('meta_responsible', m.responsible)}</td></tr>
    </table>
    <table class="exact-table ncr-material">
      <tr><th>Description of Material</th><th>ID/ Tag</th><th>Quantity</th><th>UoM</th></tr>
      <tbody>${materialRows.map(row => `<tr>${row.map(v => `<td>${inputExact('', v)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>
    <table class="exact-table"><tr><th>Description of Non Conformance (NC) (Attach Spec/ Drawings, if required)</th></tr><tr><td>${textExact('ncr_nc_desc', secVal(report,1), 'exact-tall')}</td></tr></table>
    <table class="exact-table"><tr><th>Root Cause</th></tr><tr><td>${textExact('ncr_root_cause', secVal(report,2))}</td></tr></table>
    <table class="exact-table"><tr><th>Engineering Recommendation</th></tr><tr><td>${textExact('ncr_eng_rec', secVal(report,3))}</td></tr></table>
    <table class="exact-table"><tr><th colspan="3">Proposed Corrections</th></tr><tr><td colspan="3">${textExact('ncr_proposed_corrections', secVal(report,4))}</td></tr><tr><td class="exact-label">Type</td><td><select data-exact-select="ncr_type" class="exact-select"><option value=""></option>${['Repair','Rework','Reject','Concession'].map(o=>`<option value="${o}" ${typeValue===o?'selected':''}>${o}</option>`).join('')}</select></td><td><b>Construction Concurance</b> ${inputExact('meta_constructionConcurance', m.constructionConcurance)}</td></tr></table>
    <table class="exact-table"><tr><th>Proposed Corrective Actions</th><th style="width:22%;">Target Date</th></tr><tr><td>${textExact('ncr_corrective_actions', secVal(report,6))}</td><td>${inputExact('meta_targetDate', secVal(report,7,'targetDate') || m.targetDate, 'date')}</td></tr></table>
    <table class="exact-table">
      <tr>${sigRoles.map(r=>`<th>${r}</th>`).join('')}</tr>
      <tr class="exact-sign-row">${sigs.map(s=>`<td><b>Name:</b> <input class="exact-input" data-sign-name value="${ev(s.name)}"></td>`).join('')}</tr>
      <tr class="exact-sign-row">${sigs.map(s=>`<td><b>Signature:</b> <input class="exact-input" data-sign-sign value="${ev(s.sign)}"></td>`).join('')}</tr>
      <tr class="exact-sign-row">${sigs.map(s=>`<td><b>Date:</b> <input type="date" class="exact-input" data-sign-date value="${ev(s.date)}"></td>`).join('')}</tr>
    </table>
    <table class="exact-table"><tr><td class="exact-internal">For Adani Internal Use Only</td></tr></table>
    <table class="exact-table"><tr><th>NC Disposal Summary</th></tr><tr><td>${textExact('ncr_disposal_summary', secVal(report,12), 'exact-tall')}</td></tr></table>
    <table class="exact-table"><tr><td class="exact-internal">For Adani Internal Use Only</td></tr></table>
    <table class="exact-table"><tr><th>Verification of Corrective Action</th></tr><tr><td>${textExact('ncr_verification', secVal(report,13), 'exact-tall')}</td></tr></table>
    <table class="exact-table"><tr><td class="exact-label">Code</td><td>${inputExact('meta_code', secVal(report,14,'code') || m.code)}</td></tr></table>
    <table class="exact-table">
      <tr><th colspan="3">Disposal Approved by:</th></tr>
      <tr><td><b>Name:</b> <input class="exact-input" data-disposal-name value="${ev(dispSig.name)}"></td><td><b>Signature:</b> <input class="exact-input" data-disposal-sign value="${ev(dispSig.sign)}"></td><td><b>Date:</b> <input type="date" class="exact-input" data-disposal-date value="${ev(dispSig.date)}"></td></tr>
      <tr><td colspan="3" class="exact-small">Format No. ADANI/Q/F-09 Rev 0</td></tr>
    </table>
     <!-- === SUPPORTING DOCUMENTS SECTION (ADDED) === -->
    ${report?.status !== 'Closed' ? `
    <div style="margin-top:16px; border-top:2px solid var(--line); padding-top:12px;">
      <div style="font-weight:700; font-size:15px; color:var(--blue); margin-bottom:8px;">📎 Supporting Documents</div>
      <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:10px;">
        <button type="button" class="btn btn-secondary" onclick="attachNewRfiToNcr()">📄 Create & Link RFI</button>
        <button type="button" class="btn btn-secondary" onclick="attachExistingChecklistToNcr()">📋 Link Existing Checklist</button>
        <button type="button" class="btn btn-secondary" onclick="document.getElementById('ncrAttachmentInput').click()">📎 Upload File</button>
        <input type="file" id="ncrAttachmentInput" multiple style="display:none;" onchange="uploadNcrAttachment(event)">
      </div>
      <div id="ncrSupportingDocsList" style="margin-top:8px;">
        ${renderNcrSupportingDocs(report)}
      </div>
    </div>
    ` : ''}
  </div>`;
}
// Render supporting documents for NCR
function renderNcrSupportingDocs(report) {
  const docs = report?.meta?.supportingDocs || [];
  if (!docs.length) {
    return '<div class="small" style="color:#888;">No supporting documents attached yet.</div>';
  }
  let html = '<table class="exact-table" style="font-size:12px;"><thead><tr><th>Type</th><th>Name / Reference</th><th>Added By</th><th>Date</th><th>Action</th></tr></thead><tbody>';
  docs.forEach((doc, idx) => {
    const docType = doc.type === 'rfi' ? '📄 RFI' :
                    doc.type === 'checklist' ? '📋 Checklist' :
                    doc.type === 'file' ? '📎 File' : '📌 Other';
    const name = doc.rfiNo || doc.checklistName || doc.fileName || 'Unnamed';
    const isRfi = doc.type === 'rfi';
    const isChecklist = doc.type === 'checklist';
    const isFile = doc.type === 'file';
    const canDelete = currentUser && (
      currentUser.role === 'admin' ||
      currentUser.role === 'qa_head' ||
      doc.addedBy === currentUser.username
    );
    html += `<tr>
      <td>${docType}</td>
      <td>${isRfi ? `<a href="#" onclick="openRecord('${doc.rfiId}')">${esc(name)}</a>` :
          isChecklist ? `<a href="#" onclick="openRecord('${doc.checklistId}')">${esc(name)}</a>` :
          isFile ? `<a href="${doc.fileData}" download="${esc(doc.fileName)}">${esc(doc.fileName)}</a>` :
          esc(name)}</td>
      <td>${esc(doc.addedBy || 'Unknown')}</td>
      <td>${fmtDate(doc.addedAt)}</td>
      <td>${canDelete ? `<button class="btn btn-danger" style="padding:2px 8px;font-size:10px;" onclick="removeNcrSupportingDoc(${idx})">✕</button>` : '-'}</td>
    </tr>`;
  });
  html += '</tbody></table>';
  return html;
}

// Attach a new RFI to NCR
async function attachNewRfiToNcr() {
  const rec = currentRecord();
  if (!rec || activeTemplateKey !== 'ncr') { toast('⚠️ Open an NCR first'); return; }
  if (rec.status === 'Closed') { toast('⚠️ Cannot add documents to a closed NCR'); return; }

  try { await saveReport({ preventDefault() {} }); } catch (e) { toast('❌ Failed to save NCR: ' + e.message); return; }

  pendingReturnRfiId = rec.id;
  pendingLinkedRfiNo = null;
  sessionStorage.setItem('ncrPendingDoc', JSON.stringify({ action: 'create_rfi', ncrId: rec.id, ncrNo: rec.meta?.ncrNo || rec.id }));
  openTemplate('rfi');
}

// Attach an existing checklist to NCR
async function attachExistingChecklistToNcr() {
  const rec = currentRecord();
  if (!rec || activeTemplateKey !== 'ncr') { toast('⚠️ Open an NCR first'); return; }
  if (rec.status === 'Closed') { toast('⚠️ Cannot add documents to a closed NCR'); return; }

  try { await saveReport({ preventDefault() {} }); } catch (e) { toast('❌ Failed to save NCR: ' + e.message); return; }

  const checklists = savedReports.filter(r =>
    r.templateKey !== 'rfi' && r.templateKey !== 'ncr' && r.templateKey !== 'imir' &&
    r.templateKey !== 'audit' && !r.templateKey.startsWith('activity_')
  );
  if (!checklists.length) { toast('ℹ️ No checklists available to link. Create one first.'); return; }

  let optionsHtml = checklists.map((chk, i) =>
    `<option value="${i}">${esc(chk.templateName)} - ${esc(chk.meta?.linkedRfi || 'No RFI')} (${chk.status || 'Draft'})</option>`
  ).join('');

  const modalHtml = `
    <div style="padding:16px; max-width:400px; min-width:280px;">
      <h3 style="color:var(--blue); margin-bottom:8px;">Select Checklist to Link</h3>
      <select id="ncrChecklistSelect" style="width:100%; padding:8px; border-radius:8px; border:1px solid var(--line);">${optionsHtml}</select>
      <div style="display:flex; gap:10px; margin-top:12px;">
        <button class="btn btn-primary" onclick="linkSelectedChecklistToNcr()">Link</button>
        <button class="btn btn-secondary" onclick="closeNcrDocModal()">Cancel</button>
      </div>
    </div>
  `;
  const modal = createModal(modalHtml);
  modal.id = 'ncrDocModal';
  document.body.appendChild(modal);
  modal.style.display = 'block';
}

function linkSelectedChecklistToNcr() {
  const select = document.getElementById('ncrChecklistSelect');
  if (!select) return;
  const idx = parseInt(select.value);
  const checklists = savedReports.filter(r =>
    r.templateKey !== 'rfi' && r.templateKey !== 'ncr' && r.templateKey !== 'imir' &&
    r.templateKey !== 'audit' && !r.templateKey.startsWith('activity_')
  );
  const chk = checklists[idx];
  if (!chk) { toast('⚠️ Checklist not found'); return; }
  const rec = currentRecord();
  if (!rec) { toast('⚠️ No NCR open'); return; }

  const docs = rec.meta?.supportingDocs || [];
  docs.push({
    type: 'checklist',
    checklistId: chk.id,
    checklistName: chk.templateName || 'Checklist',
    addedBy: currentUser.display || currentUser.username,
    addedAt: new Date().toISOString()
  });
  rec.meta.supportingDocs = docs;
  saveReport({ preventDefault() {} }).then(() => {
    toast('✅ Checklist linked to NCR');
    closeNcrDocModal();
  });
}

// Upload a file attachment to NCR
async function uploadNcrAttachment(event) {
  const files = event.target.files;
  if (!files || !files.length) return;
  const rec = currentRecord();
  if (!rec || activeTemplateKey !== 'ncr') { toast('⚠️ Open an NCR first'); return; }
  if (rec.status === 'Closed') { toast('⚠️ Cannot add files to a closed NCR'); return; }

  for (const file of files) {
    let blobToEncode = file;
    if (file.type && file.type.startsWith('image/') && file.size > 1024 * 1024) {
      try { blobToEncode = await compressImage(file, 800, 0.7); } catch (e) { console.warn('Compression failed', e); }
    }
    const data = await readFileAsBase64(blobToEncode);
    const docs = rec.meta?.supportingDocs || [];
    docs.push({
      type: 'file',
      fileName: file.name,
      fileData: data,
      fileType: file.type,
      addedBy: currentUser.display || currentUser.username,
      addedAt: new Date().toISOString()
    });
    rec.meta.supportingDocs = docs;
  }
  await saveReport({ preventDefault() {} });
  toast(`✅ ${files.length} file(s) attached to NCR`);
  event.target.value = '';
}

// Remove a supporting document
async function removeNcrSupportingDoc(idx) {
  const rec = currentRecord();
  if (!rec) { toast('⚠️ No NCR open'); return; }
  const docs = rec.meta?.supportingDocs || [];
  if (idx < 0 || idx >= docs.length) return;
  docs.splice(idx, 1);
  rec.meta.supportingDocs = docs;
  await saveReport({ preventDefault() {} });
  toast('🗑️ Document removed');
}

// Close the modal
function closeNcrDocModal() {
  const modal = document.getElementById('ncrDocModal');
  if (modal) modal.remove();
}

// Create a modal overlay
function createModal(contentHtml) {
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed; top:0; left:0; width:100%; height:100%;
    background: rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center;
    z-index:99999; backdrop-filter: blur(4px);
  `;
  const box = document.createElement('div');
  box.style.cssText = `
    background: #fff; border-radius:16px; max-width:90%; max-height:90%; overflow:auto;
    box-shadow: 0 20px 60px rgba(0,0,0,0.3); padding:20px;
  `;
  box.innerHTML = contentHtml;
  overlay.appendChild(box);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  return overlay;
}

// Scroll to the doc panel (for the button)
function showNcrDocPanel() {
  const rec = currentRecord();
  if (!rec || activeTemplateKey !== 'ncr') { toast('⚠️ Open an NCR first'); return; }
  const section = document.querySelector('#ncrSupportingDocsList');
  if (section) {
    section.scrollIntoView({ behavior: 'smooth', block: 'center' });
    section.style.background = 'rgba(255,215,0,0.15)';
    setTimeout(() => section.style.background = 'transparent', 2000);
  }
}
function renderIMIRExact(report) {
  const m = report?.meta || {};
  const materialRows = rowVals(report, 0, 5, 6);
  const sigRoles = ['Merit Execution', 'Merit QA/QC', 'Adani Execution', 'Adani FQA', 'Adani QA/QC'];
  const sigs = signEntries(report, 4, sigRoles);
  return `
  <div class="exact-format imir-exact">
    <table class="exact-table">
      <tr><th colspan="4" class="exact-main-title">MATERIAL APPROVAL</th></tr>
      <tr><td class="exact-label">Client:</td><td>${inputExact('meta_client', m.client || 'M/s Adani Entreprises Ltd')}</td><td class="exact-label">Package/System:</td><td>${inputExact('meta_package', m.package)}</td></tr>
      <tr><td class="exact-label">Date&nbsp; :</td><td>${inputExact('meta_date', m.date, 'date')}</td><td class="exact-label">Location:</td><td>${inputExact('meta_location', m.location || appConfig.location)}</td></tr>
      <tr><td class="exact-label">Drawing No.:</td><td colspan="3">${inputExact('meta_drawingNo', m.drawingNo)}</td></tr>
    </table>
    <table class="exact-table">
      <tr><th colspan="3" style="text-align:left;">Material Appproval Submittal :-</th><th>STATUS<br>CODE</th></tr>
      <tr><td class="exact-label">To</td><td>${inputExact('meta_to', m.to || 'FQA Head Adani')}</td><td>Approved</td><td class="exact-center"><b>A</b></td></tr>
      <tr><td class="exact-label">Subject</td><td>${inputExact('meta_subject', m.subject)}</td><td>Approved As Noted</td><td class="exact-center"><b>B</b></td></tr>
      <tr><td colspan="2" class="exact-note">We are forwarding herewith, the submissions Listed below for your action.</td><td>Not Approved</td><td class="exact-center"><b>C</b></td></tr>
    </table>
    <table class="exact-table imir-material">
      <tr><th>Sl. No</th><th>Material Description</th><th>Manufacturer</th><th>Supplier</th><th>Structure of Indent use</th><th>Status<br>A&nbsp;&nbsp;B&nbsp;&nbsp;C</th></tr>
      <tbody>${materialRows.map((row, r) => `<tr>${row.map((v,c) => `<td>${inputExact('', v || (c===0 ? String(r+1) : ''))}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>
    <table class="exact-table"><tr><td class="exact-label">Relevant Drawing:-</td><td>${textExact('imir_relevant_drawing', secVal(report,1))}</td></tr></table>
    <table class="exact-table"><tr><td class="exact-label">Relevant Specification&nbsp; No:-</td><td>${textExact('imir_relevant_spec', secVal(report,2))}</td></tr></table>
    <table class="exact-table"><tr><td class="exact-label">Remarks</td><td>${textExact('imir_remarks', secVal(report,3))}</td></tr></table>
    <table class="exact-table imir-signatures">
      <tr><th>Signatory</th>${sigRoles.map(r=>`<th>${r}</th>`).join('')}</tr>
      <tr><td><b>Name</b></td>${sigs.map(s=>`<td><input class="exact-input" data-sign-name value="${ev(s.name)}"></td>`).join('')}</tr>
      <tr><td><b>Signature</b></td>${sigs.map(s=>`<td><input class="exact-input" data-sign-sign value="${ev(s.sign)}"></td>`).join('')}</tr>
      <tr><td><b>Date</b></td>${sigs.map(s=>`<td><input type="date" class="exact-input" data-sign-date value="${ev(s.date)}"></td>`).join('')}</tr>
    </table>
  </div>`;
}
function renderAuditExact(report) {
  const m = report?.meta || {};
  
let auditRows = report?.sections?.[0]?.rows || [];
if (!auditRows.length) {
  const templateRows = templates.audit.sections[0].rows;
  auditRows = templateRows.map(task => ({
    task: task,
    available: '',
    documents: '',
    satisfactory: '',
    remarks: '',
    linkedNCRs: []  // ← ADD THIS
  }));
} else {
  // Ensure each row has a linkedNCRs array
  auditRows = auditRows.map(row => ({
    ...row,
    linkedNCRs: row.linkedNCRs || []
  }));
}
  let html = `
  <div class="exact-format audit-exact">
    <table class="exact-table" style="border-bottom: none;">
      <tr><td colspan="6" style="text-align:center; border-bottom: none; font-size:20px; font-weight:700; padding:8px 4px 2px 4px;">QA/QC SUITE</td></tr>
      <tr><td colspan="6" style="text-align:center; border-top: none; border-bottom: none; font-size:14px; font-weight:700; padding:2px 4px;">QA / QC AUDIT RECORDS</td></tr>
      <tr><td colspan="6" style="text-align:center; border-top: none; border-bottom: none; font-size:12px; font-weight:700; padding:2px 4px 6px 4px;">Format No. - AUDIT / QA / 001</td></tr>
      <tr><td colspan="6" style="text-align:center; border-top: none; font-size:18px; font-weight:700; padding:8px 4px 12px 4px;">PROJECT AUDIT REPORT</td></tr>
    </table>
    
    <table class="exact-table">
      <tr><td class="exact-label" style="width:16%;">Report No:</td><td colspan="5">${inputExact('meta_reportNo', m.reportNo)}</td></tr>
      <tr><td class="exact-label">Project:</td><td colspan="2">${inputExact('meta_project', m.project)}</td><td class="exact-label" style="width:14%;">Audit Date  :</td><td colspan="2">${inputExact('meta_auditDate', m.auditDate, 'date')}</td></tr>
      <tr><td class="exact-label">Client:</td><td colspan="2">${inputExact('meta_client', m.client)}</td><td class="exact-label">Auditor:</td><td colspan="2">${inputExact('meta_auditor', m.auditor)}</td></tr>
      <tr><td class="exact-label">Consultant:</td><td colspan="2">${inputExact('meta_consultant', m.consultant)}</td><td class="exact-label">Nature Of Contractor:</td><td colspan="2">${inputExact('meta_contractorNature', m.contractorNature)}</td></tr>
      <tr><td class="exact-label">Project Value:</td><td colspan="2">${inputExact('meta_projectValue', m.projectValue)}</td><td class="exact-label">Assessment dates:</td><td colspan="2">${inputExact('meta_assessmentDates', m.assessmentDates)}</td></tr>
      <tr><td class="exact-label">Client address:</td><td colspan="2">${inputExact('meta_clientAddress', m.clientAddress)}</td><td class="exact-label">Reporting dates:</td><td colspan="2">${inputExact('meta_reportingDates', m.reportingDates)}</td></tr>
      <tr><td class="exact-label">Assessment team:</td><td colspan="2">${inputExact('meta_assessmentTeam', m.assessmentTeam)}</td><td class="exact-label">Assessment criteria:</td><td colspan="2">${inputExact('meta_assessmentCriteria', m.assessmentCriteria)}</td></tr>
      <!-- Agency row removed – now placed outside the format -->
    </table>

     <table class="exact-table audit-checklist">
      <tr>
        <th style="width:6%;">sr no</th>
        <th style="width:38%;">Tasks</th>
        <th style="width:12%;">Available (Y/N)</th>
        <th style="width:12%;">Documents(Y/N)</th>
        <th style="width:16%;">satisfactory/ Unsatisfactory</th>
        <th style="width:16%;">Remarks</th>
      </tr>
      ${auditRows.map((row, idx) => `
        <tr>
          <td style="text-align:center;">${idx+1}</td>
          <td>${esc(row.task || '')}</td>
          <td>${inputExact('', row.available, 'select', ['', 'Y', 'N'])}</td>
          <td>${inputExact('', row.documents, 'select', ['', 'Y', 'N'])}</td>
          <td>${inputExact('', row.satisfactory, 'select', ['', 'Satisfactory', 'Unsatisfactory'])}</td>
          <td>
            <div class="audit-remarks-cell" 
                 data-row-index="${idx}" 
                 data-linked-ncrs='${JSON.stringify(row.linkedNCRs || [])}'>
              <div class="ncr-badges" id="auditNcrBadges_${idx}">
                ${renderAuditNcrBadges(row.linkedNCRs || [])}
              </div>
              <button type="button" class="btn btn-secondary btn-sm" onclick="addNcrToAuditRow(${idx})" style="padding:2px 8px; font-size:11px; margin-top:4px;">
                ➕ Add NCR
              </button>
            </div>
          </td>
        </tr>
      `).join('')}
    </table>

    <table class="exact-table"><tr><th style="text-align:left; padding:6px 8px;">Project Description</th></tr><tr><td>${textExact('audit_description', secVal(report, 1))}</td></tr></table>
    <table class="exact-table"><tr><th style="text-align:left; padding:6px 8px;">Areas of Appreciation:</th></tr><tr><td>${textExact('audit_appreciation', secVal(report, 2))}</td></tr></table>
    <table class="exact-table"><tr><th style="text-align:left; padding:6px 8px;">Non-Compliance VS Compliance</th></tr><tr><td>${textExact('audit_compliance', secVal(report, 3))}</td></tr></table>

    <table class="exact-table">
      <tr><th style="width:33%;">Auditor</th><th style="width:33%;">Project Manager</th><th style="width:34%;">QA Head</th></tr>
      <tr>
        <td><b>Name:</b> <input class="exact-input" data-sign-name-auditor><br><b>Signature:</b> <input class="exact-input" data-sign-sign-auditor><br><b>Date:</b> <input type="date" class="exact-input" data-sign-date-auditor></td>
        <td><b>Name:</b> <input class="exact-input" data-sign-name-pm><br><b>Signature:</b> <input class="exact-input" data-sign-sign-pm><br><b>Date:</b> <input type="date" class="exact-input" data-sign-date-pm></td>
        <td><b>Name:</b> <input class="exact-input" data-sign-name-qa><br><b>Signature:</b> <input class="exact-input" data-sign-sign-qa><br><b>Date:</b> <input type="date" class="exact-input" data-sign-date-qa></td>
      </tr>
    </table>
  </div>`;
  return html;
}
// Render NCR badges for audit row
// ============================================================
// AUDIT – NCR LINKING FUNCTIONS
// ============================================================

// Render NCR badges for audit row
function renderAuditNcrBadges(ncrList = []) {
  if (!ncrList || !ncrList.length) return '';
  return ncrList.map((ncr, index) => `
    <span class="badge ok" style="cursor:pointer; margin:2px 4px 2px 0; display:inline-block;" 
          onclick="openRecord('${ncr.ncrId}')" title="Click to open NCR">
      📋 ${esc(ncr.ncrNo || 'NCR')}
      <span style="cursor:pointer; color:red; margin-left:4px;" 
            onclick="event.stopPropagation();removeAuditNcr(${ncr.rowIndex}, ${index})">✕</span>
    </span>
  `).join('');
}
// Add NCR to audit row – opens a new NCR form
function addNcrToAuditRow(rowIndex) {
  const rec = currentRecord();
  if (!rec || activeTemplateKey !== 'audit') { 
    toast('⚠️ Open an Audit first'); 
    return; 
  }

  // Save the audit first to ensure we have the latest data
  saveReport({ preventDefault() {} }).then(() => {
    // Store context so that when NCR is saved, we know which audit row to link it to
    sessionStorage.setItem('auditNcrLinkContext', JSON.stringify({
      auditId: rec.id,
      rowIndex: rowIndex,
      auditNo: rec.meta?.reportNo || rec.id
    }));
    
    // Open a new NCR template
    openTemplate('ncr');
  }).catch(e => {
    toast('❌ Failed to save audit: ' + e.message);
  });
}


// Remove NCR from audit row
async function removeAuditNcr(rowIndex, ncrIndex) {
  const rec = currentRecord();
  if (!rec || activeTemplateKey !== 'audit') { 
    toast('⚠️ Open an Audit first'); 
    return; 
  }

  const sections = rec.sections || [];
  const auditTable = sections[0] || { rows: [] };
  const rows = auditTable.rows || [];
  const row = rows[rowIndex] || {};
  const linkedNCRs = row.linkedNCRs || [];

  if (ncrIndex < 0 || ncrIndex >= linkedNCRs.length) return;
  linkedNCRs.splice(ncrIndex, 1);
  row.linkedNCRs = linkedNCRs;
  rows[rowIndex] = row;
  auditTable.rows = rows;
  sections[0] = auditTable;
  rec.sections = sections;

  await saveReport({ preventDefault() {} });
  toast('🗑️ NCR removed from row');
  renderSheet(templates[activeTemplateKey], rec);
}

// ------------------------------------------------------------
// Optional: Dropdown selector for adding NCRs (instead of prompt)
// ------------------------------------------------------------
function loadAuditNcrDropdown(rowIndex) {
  const ncrs = savedReports.filter(r => r.templateKey === 'ncr');
  if (!ncrs.length) {
    toast('ℹ️ No NCRs available. Create one first.');
    return;
  }

  const modalHtml = `
    <div style="padding:16px; max-width:400px; min-width:280px;">
      <h3 style="color:var(--blue); margin-bottom:8px;">Select NCR to Link</h3>
      <div style="max-height:300px; overflow-y:auto;">
        ${ncrs.map(n => `
          <div style="padding:8px; border-bottom:1px solid #eee; cursor:pointer;" 
               onclick="selectAuditNcr(${rowIndex}, '${n.id}', '${n.meta?.ncrNo || n.id}')">
            <b>${esc(n.meta?.ncrNo || n.id)}</b> - ${esc(n.titleLoc || 'No project')}
            <span class="badge ${n.status === 'Closed' ? 'ok' : 'mid'}">${esc(n.status || 'Draft')}</span>
          </div>
        `).join('')}
      </div>
      <div style="display:flex; gap:10px; margin-top:12px;">
        <button class="btn btn-secondary" onclick="closeNcrDocModal()">Cancel</button>
      </div>
    </div>
  `;
  const modal = createModal(modalHtml);
  modal.id = 'ncrDocModal';
  document.body.appendChild(modal);
  modal.style.display = 'block';
}

function selectAuditNcr(rowIndex, ncrId, ncrNo) {
  const rec = currentRecord();
  if (!rec || activeTemplateKey !== 'audit') { 
    toast('⚠️ Open an Audit first'); 
    return; 
  }

  const sections = rec.sections || [];
  const auditTable = sections[0] || { rows: [] };
  const rows = auditTable.rows || [];
  const row = rows[rowIndex] || {};
  const linkedNCRs = row.linkedNCRs || [];

  if (linkedNCRs.some(n => n.ncrId === ncrId || n.ncrNo === ncrNo)) {
    toast('⚠️ This NCR is already linked to this row.');
    return;
  }

  linkedNCRs.push({
    ncrNo: ncrNo,
    ncrId: ncrId,
    rowIndex: rowIndex   // ← store rowIndex
  });

  row.linkedNCRs = linkedNCRs;
  rows[rowIndex] = row;
  auditTable.rows = rows;
  sections[0] = auditTable;
  rec.sections = sections;

  saveReport({ preventDefault() {} }).then(() => {
    toast('✅ NCR linked to audit row');
    closeNcrDocModal();
    renderSheet(templates[activeTemplateKey], rec);
  });
}
 // ============================================================
// RENDER activity CHECKLIST
// ============================================================
function renderactivityExact(report) {
  const m = report?.meta || {};
  const section = report?.sections?.[0] || {};
  const items = section.items || [];
  
  let html = `
  <div class="exact-format activity-exact">
    <table class="exact-table">
      <tr><th colspan="4" class="exact-main-title">${esc(report?.templateName || 'activity CHECKLIST')}</th></tr>
      <tr><td class="exact-label">Linked Audit Report:</td><td colspan="3">${inputExact('meta_linkedAudit', m.linkedAudit, 'select', getAuditOptions())}</td></tr>
      <tr><td class="exact-label">Project:</td><td>${inputExact('meta_project', m.project)}</td><td class="exact-label">Audit Date:</td><td>${inputExact('meta_date', m.date, 'date')}</td></tr>
      <tr><td class="exact-label">Contractor:</td><td>${inputExact('meta_contractor', m.contractor)}</td><td class="exact-label">Location:</td><td>${inputExact('meta_location', m.location)}</td></tr>
    </table>

    <table class="exact-table activity-checklist">
      <tr><th>Sr No</th><th>Check Point</th><th>Status</th><th>Remarks</th></tr>
      ${items.map((item, idx) => `
        <tr>
          <td style="text-align:center; width:8%;">${idx+1}</td>
          <td>${esc(item)}</td>
          <td style="width:15%;">${inputExact('', '', 'select', ['', 'Yes', 'No', 'NA'])}</td>
          <td style="width:25%;">${inputExact('', '')}</td>
        </tr>
      `).join('')}
    </table>

    <table class="exact-table"><tr><th>Remarks / Comments</th></tr><tr><td>${textExact('activity_remarks', secVal(report, 1))}</td></tr></table>
    <table class="exact-table">
      <tr><th>Contractor QA/QC</th><th>Company QA/QC</th><th>QA Head</th></tr>
      <tr>${['contractor', 'company', 'qa'].map(role => `<td><b>Name:</b> <input class="exact-input" data-sign-name-${role}><br><b>Signature:</b> <input class="exact-input" data-sign-sign-${role}><br><b>Date:</b> <input type="date" class="exact-input" data-sign-date-${role}></td>`).join('')}</tr>
    </table>
  </div>`;
  return html;
} 
// ============================================================
// RENDER COMPLIANCE REPORT
// ============================================================
function renderComplianceExact(report) {
  const m = report?.meta || {};
  const sectionsData = report?.sections || [];
  const tableData = sectionsData[0] || { rows: [] };
  const commitmentData = sectionsData[1] || { value: '' };
  const signaturesData = sectionsData[2] || { entries: [] };

  let html = `
  <div class="exact-format compliance-exact">
    <!-- Header -->
    <table class="exact-table">
      <tr>
        <td colspan="4" style="text-align:center; font-size:18px; font-weight:700; padding:10px 4px; background:#f0f4fa;">
          COMPLIANCE REPORT (PART OF CAPA)
        </td>
      </tr>
      <tr>
        <td class="exact-label">Project :</td>
        <td>${inputExact('meta_project', m.project)}</td>
        <td class="exact-label">Audit Conducted By :</td>
        <td>${inputExact('meta_auditor', m.auditor)}</td>
      </tr>
      <tr>
        <td class="exact-label">Audit Conducted :</td>
        <td colspan="3">
          ${inputExact('meta_auditFrom', m.auditFrom, 'date')} To ${inputExact('meta_auditTo', m.auditTo, 'date')}
        </td>
      </tr>
      <tr>
        <td class="exact-label">Audit Report No :</td>
        <td>${inputExact('meta_auditReportNo', m.auditReportNo)}</td>
        <td class="exact-label">Auditor Name :</td>
        <td>${inputExact('meta_auditorName', m.auditorName)}</td>
      </tr>
    </table>

    <!-- Compliance Table -->
    <table class="exact-table compliance-table">
      <thead>
        <tr>
          ${['Sr. No.', 'NCR Nos. (With Details)', 'Description', 'Image (Before Correction)', 'Severity', 'Frequency', 'Requirement', 'Root Cause', 'Correction', 'Image (After Correction)', 'Corrective Action', 'Remarks'].map(col => `<th style="font-size:10px; padding:4px 3px; text-align:center;">${col}</th>`).join('')}
        </tr>
      </thead>
      <tbody>
        ${Array.from({ length: 25 }, (_, i) => {
          const row = (tableData.rows && tableData.rows[i]) || {};
          return `
            <tr>
              <td style="text-align:center; width:4%;">${i + 1}</td>
              <td style="width:8%;">${inputExact('', row.ncrNo || '')}</td>
              <td style="width:12%;">${inputExact('', row.description || '')}</td>
              <td style="width:8%;">
                <input type="file" accept="image/*" onchange="previewImage(this, 'before_${i}')" style="font-size:10px; width:100%;">
                <div id="before_${i}" style="margin-top:4px; max-width:80px;"></div>
              </td>
              <td style="width:6%;">${inputExact('', row.severity || '', 'select', ['', 'Major', 'Minor', 'Critical'])}</td>
              <td style="width:6%;">${inputExact('', row.frequency || '', 'select', ['', 'Once', 'Occasional', 'Repeated'])}</td>
              <td style="width:10%;">${inputExact('', row.requirement || '')}</td>
              <td style="width:10%;">${inputExact('', row.rootCause || '')}</td>
              <td style="width:10%;">${inputExact('', row.correction || '')}</td>
              <td style="width:8%;">
                <input type="file" accept="image/*" onchange="previewImage(this, 'after_${i}')" style="font-size:10px; width:100%;">
                <div id="after_${i}" style="margin-top:4px; max-width:80px;"></div>
              </td>
              <td style="width:8%;">${inputExact('', row.correctiveAction || '')}</td>
              <td style="width:10%;">${inputExact('', row.remarks || '')}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>

    <!-- Commitment -->
    <table class="exact-table">
      <tr>
        <td style="font-weight:700; padding:8px; background:#f0f4fa; font-size:13px;">
          OUR COMMITMENT:
        </td>
        <td style="padding:8px;">
          ${textExact('compliance_commitment', secVal(report, 1))}
        </td>
      </tr>
    </table>

    <!-- Signatures -->
    <table class="exact-table compliance-signatures">
      <tr>
        <th style="width:33%;">Prepared By</th>
        <th style="width:33%;">Reviewed By</th>
        <th style="width:34%;">Approved By</th>
      </tr>
      <tr>
        ${['prepared', 'reviewed', 'approved'].map(role => `
          <td>
            <b>Name:</b> <input class="exact-input" data-sign-name-${role}><br>
            <b>Signature:</b> <input class="exact-input" data-sign-sign-${role}><br>
            <b>Date:</b> <input type="date" class="exact-input" data-sign-date-${role}>
          </td>
        `).join('')}
      </tr>
    </table>
  </div>`;

  return html;
}
// ============================================================
// COLLECT COMPLIANCE SECTIONS
// ============================================================
function collectComplianceSectionsExact() {
  const root = document.querySelector('.compliance-exact');
  if (!root) return [];

  // Collect table rows
  const tableRows = Array.from(root.querySelectorAll('.compliance-table tbody tr')).map((tr, idx) => {
    const inputs = tr.querySelectorAll('input, select, textarea');
    return {
      ncrNo: inputs[0]?.value || '',
      description: inputs[1]?.value || '',
      severity: inputs[2]?.value || '',
      frequency: inputs[3]?.value || '',
      requirement: inputs[4]?.value || '',
      rootCause: inputs[5]?.value || '',
      correction: inputs[6]?.value || '',
      correctiveAction: inputs[7]?.value || '',
      remarks: inputs[8]?.value || ''
    };
  });

  // Collect signatures
  const sigs = {
    prepared: {
      name: root.querySelector('[data-sign-name-prepared]')?.value || '',
      sign: root.querySelector('[data-sign-sign-prepared]')?.value || '',
      date: root.querySelector('[data-sign-date-prepared]')?.value || ''
    },
    reviewed: {
      name: root.querySelector('[data-sign-name-reviewed]')?.value || '',
      sign: root.querySelector('[data-sign-sign-reviewed]')?.value || '',
      date: root.querySelector('[data-sign-date-reviewed]')?.value || ''
    },
    approved: {
      name: root.querySelector('[data-sign-name-approved]')?.value || '',
      sign: root.querySelector('[data-sign-sign-approved]')?.value || '',
      date: root.querySelector('[data-sign-date-approved]')?.value || ''
    }
  };

  return [
    { type: 'compliance_table', rows: tableRows },
    { type: 'textarea', value: root.querySelector('[data-exact-text="compliance_commitment"]')?.value || '' },
    { type: 'signatures', entries: [
      { role: 'Prepared By', name: sigs.prepared.name, sign: sigs.prepared.sign, date: sigs.prepared.date },
      { role: 'Reviewed By', name: sigs.reviewed.name, sign: sigs.reviewed.sign, date: sigs.reviewed.date },
      { role: 'Approved By', name: sigs.approved.name, sign: sigs.approved.sign, date: sigs.approved.date }
    ]}
  ];
}
// Helper to preview images in compliance table
function previewImage(input, containerId) {
  const container = document.getElementById(containerId);
  if (container && input.files && input.files[0]) {
    const reader = new FileReader();
    reader.onload = function(e) {
      container.innerHTML = `<img src="${e.target.result}" style="max-width:80px; max-height:80px; border:1px solid #ddd; border-radius:4px;">`;
    };
    reader.readAsDataURL(input.files[0]);
  }
}

function collectNCRSectionsExact() {
  const root = document.querySelector('.ncr-exact');
  if (!root) return [];
  const materialRows = Array.from(root.querySelectorAll('.ncr-material tbody tr')).map(tr => Array.from(tr.querySelectorAll('input')).map(i => i.value));
  const signTable = root.querySelectorAll('.exact-table')[10];
  const signCellsByRow = signTable ? Array.from(signTable.querySelectorAll('tr')).slice(1,4) : [];
  function signAt(i) {
    return {
      name: signCellsByRow[0]?.cells[i]?.querySelector('[data-sign-name]')?.value || '',
      sign: signCellsByRow[1]?.cells[i]?.querySelector('[data-sign-sign]')?.value || '',
      date: signCellsByRow[2]?.cells[i]?.querySelector('[data-sign-date]')?.value || ''
    };
  }
  return [
    { type:'table', rows: materialRows },
    { type:'textarea', value: root.querySelector('[data-exact-text="ncr_nc_desc"]')?.value || '' },
    { type:'textarea', value: root.querySelector('[data-exact-text="ncr_root_cause"]')?.value || '' },
    { type:'textarea', value: root.querySelector('[data-exact-text="ncr_eng_rec"]')?.value || '' },
    { type:'textarea', value: root.querySelector('[data-exact-text="ncr_proposed_corrections"]')?.value || '' },
    { type:'status', value: root.querySelector('[data-exact-select="ncr_type"]')?.value || '' },
    { type:'textarea', value: root.querySelector('[data-exact-text="ncr_corrective_actions"]')?.value || '' },
    { type:'date', targetDate: document.getElementById('meta_targetDate')?.value || '' },
    { type:'signatures', entries: [signAt(0)] },
    { type:'signatures', entries: [signAt(1)] },
    { type:'signatures', entries: [signAt(2)] },
    { type:'signatures', entries: [signAt(3)] },
    { type:'textarea', value: root.querySelector('[data-exact-text="ncr_disposal_summary"]')?.value || '' },
    { type:'textarea', value: root.querySelector('[data-exact-text="ncr_verification"]')?.value || '' },
    { type:'text', code: document.getElementById('meta_code')?.value || '' },
    { type:'signatures', entries: [{
      name: root.querySelector('[data-disposal-name]')?.value || '',
      sign: root.querySelector('[data-disposal-sign]')?.value || '',
      date: root.querySelector('[data-disposal-date]')?.value || ''
    }] }
  ];
}

function collectIMIRSectionsExact() {
  const root = document.querySelector('.imir-exact');
  if (!root) return [];
  const materialRows = Array.from(root.querySelectorAll('.imir-material tbody tr')).map(tr => Array.from(tr.querySelectorAll('input')).map(i => i.value));
  const sigTable = root.querySelector('.imir-signatures');
  const sigRows = sigTable ? Array.from(sigTable.querySelectorAll('tr')).slice(1,4) : [];
  const roles = ['Merit Execution', 'Merit QA/QC', 'Adani Execution', 'Adani FQA', 'Adani QA/QC'];
  const entries = roles.map((role, i) => ({
    role,
    name: sigRows[0]?.cells[i+1]?.querySelector('[data-sign-name]')?.value || '',
    sign: sigRows[1]?.cells[i+1]?.querySelector('[data-sign-sign]')?.value || '',
    date: sigRows[2]?.cells[i+1]?.querySelector('[data-sign-date]')?.value || ''
  }));
  return [
    { type:'table', rows: materialRows },
    { type:'textarea', value: root.querySelector('[data-exact-text="imir_relevant_drawing"]')?.value || '' },
    { type:'textarea', value: root.querySelector('[data-exact-text="imir_relevant_spec"]')?.value || '' },
    { type:'textarea', value: root.querySelector('[data-exact-text="imir_remarks"]')?.value || '' },
    { type:'signatures', entries }
  ];
}
function collectAuditSectionsExact() {
  const root = document.querySelector('.audit-exact');
  if (!root) return [];

  // Collect audit table rows (checklist)
  const tableRows = Array.from(root.querySelectorAll('.audit-checklist tbody tr')).map((tr, idx) => {
    const inputs = tr.querySelectorAll('input, select');
    const remarksCell = tr.querySelector('.audit-remarks-cell');
    let linkedNCRs = [];

    // Try to read from the data attribute (set during rendering)
    if (remarksCell) {
      const dataAttr = remarksCell.getAttribute('data-linked-ncrs');
      if (dataAttr) {
        try { linkedNCRs = JSON.parse(dataAttr); } catch(e) { linkedNCRs = []; }
      }
    }

    // If the data attribute is missing, fallback to reading from the current row object
    // but we don't have that here – so we'll just keep an empty array.
    // This ensures we don't lose existing linked NCRs if the attribute is missing.

    return {
      task: tr.cells[1]?.textContent.trim() || '',
      available: inputs[0]?.value || '',
      documents: inputs[1]?.value || '',
      satisfactory: inputs[2]?.value || '',
      remarks: inputs[3]?.value || '',
      linkedNCRs: linkedNCRs
    };
  });

  // Collect signatures (unchanged)
  const sigs = {
    auditor: { name: root.querySelector('[data-sign-name-auditor]')?.value || '', sign: root.querySelector('[data-sign-sign-auditor]')?.value || '', date: root.querySelector('[data-sign-date-auditor]')?.value || '' },
    pm: { name: root.querySelector('[data-sign-name-pm]')?.value || '', sign: root.querySelector('[data-sign-sign-pm]')?.value || '', date: root.querySelector('[data-sign-date-pm]')?.value || '' },
    qa: { name: root.querySelector('[data-sign-name-qa]')?.value || '', sign: root.querySelector('[data-sign-sign-qa]')?.value || '', date: root.querySelector('[data-sign-date-qa]')?.value || '' }
  };

  return [
    { type: 'audit_table', rows: tableRows },
    { type: 'textarea', value: root.querySelector('[data-exact-text="audit_description"]')?.value || '' },
    { type: 'textarea', value: root.querySelector('[data-exact-text="audit_appreciation"]')?.value || '' },
    { type: 'textarea', value: root.querySelector('[data-exact-text="audit_compliance"]')?.value || '' },
    { type: 'signatures', entries: [
      { role: 'Auditor', name: sigs.auditor.name, sign: sigs.auditor.sign, date: sigs.auditor.date },
      { role: 'Project Manager', name: sigs.pm.name, sign: sigs.pm.sign, date: sigs.pm.date },
      { role: 'QA Head', name: sigs.qa.name, sign: sigs.qa.sign, date: sigs.qa.date }
    ]}
  ];
}
 function collectactivitySectionsExact() {
  const root = document.querySelector('.activity-exact');
  if (!root) return [];

  // Collect checklist rows
  const items = Array.from(root.querySelectorAll('.activity-checklist tbody tr')).map(tr => {
    const inputs = tr.querySelectorAll('input, select');
    return {
      item: tr.cells[1]?.textContent.trim() || '',
      status: inputs[0]?.value || '',
      remarks: inputs[1]?.value || ''
    };
  });

  return [
    { type: 'activity_checklist', items: items },
    { type: 'textarea', value: root.querySelector('[data-exact-text="activity_remarks"]')?.value || '' },
    { type: 'signatures', entries: [
      { role: 'Contractor QA/QC', name: root.querySelector('[data-sign-name-contractor]')?.value || '', sign: root.querySelector('[data-sign-sign-contractor]')?.value || '', date: root.querySelector('[data-sign-date-contractor]')?.value || '' },
      { role: 'Company QA/QC', name: root.querySelector('[data-sign-name-company]')?.value || '', sign: root.querySelector('[data-sign-sign-company]')?.value || '', date: root.querySelector('[data-sign-date-company]')?.value || '' },
      { role: 'QA Head', name: root.querySelector('[data-sign-name-qa]')?.value || '', sign: root.querySelector('[data-sign-sign-qa]')?.value || '', date: root.querySelector('[data-sign-date-qa]')?.value || '' }
    ]}
  ];
} 

// ============================================================
// 6. UTILITY FUNCTIONS (with date/time fixes)
// ============================================================
function toast(msg) {
  const t = document.getElementById('toast');
  t.innerText = msg;
  t.style.display = 'block';
  setTimeout(() => t.style.display = 'none', 2000);
}
 function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}
  function compressImage(file, maxWidth = 800, quality = 0.7) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width, height = img.height;
        if (width > maxWidth) {
          height = (height * maxWidth) / width;
          width = maxWidth;
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => {
          resolve(blob);
        }, file.type, quality);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}
function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmtDate(v) {
  if (!v) return '';
  const d = new Date(v);
  return String(d) === 'Invalid Date' ? String(v) : d.toLocaleDateString('en-GB');
}
function fmtDateTime(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  return d.toLocaleString('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
}
function fmtTimeAgo(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  const diff = Math.floor((now - d) / 1000);
  if (diff < 60) return diff + 's ago';
  if (diff < 3600) return Math.floor(diff/60) + 'm ago';
  if (diff < 86400) return Math.floor(diff/3600) + 'h ago';
  return Math.floor(diff/86400) + 'd ago';
}
function todayText() {
  return new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
function getRfiRecords() { return savedReports.filter(r => r.templateKey === 'rfi'); }
function getNcrRecords() { return savedReports.filter(r => r.templateKey === 'ncr'); }
function getRfiOptions() {
  const vals = getRfiRecords().map(r => r.meta?.rfiNo || r.id).filter(Boolean);
  return [...new Set(vals)];
}
function getAuditOptions() {
  const audits = savedReports.filter(r => r.templateKey === 'audit');
  const options = audits.map(r => r.meta?.reportNo || r.id || '');
  return [...new Set(options)];
}
function generateAgencyRadios(currentValue, type = 'checkbox') {
    const selected = Array.isArray(currentValue) ? currentValue : (currentValue ? [currentValue] : []);
    // Ensure agencyUsers is an array
    let recipients = Array.isArray(agencyUsers) ? agencyUsers : [];
    // If still empty, fallback to static users (with proper fields)
    if (!recipients.length) {
        recipients = users.filter(u => u.role === 'engineer' || u.role === 'exec_engineer').map(u => ({
            username: u.u || u.username || u.id,
            displayName: u.name || u.full_name || u.u,
            role: u.role,
            sites: u.assigned_sites || []
        }));
    }
    const inputType = type === 'radio' ? 'radio' : 'checkbox';

    return recipients.map(user => {
        const checked = selected.includes(user.username) ? 'checked' : '';
        const roleLabel = user.role === 'engineer' ? 'Contractor' : 'Execution Engineer';
        const siteLabel = user.sites.length ? user.sites.join(', ') : 'No Site';
        const displayText = `${user.displayName} (${roleLabel} - ${siteLabel})`;

        return `<label style="display:inline-flex; align-items:center; gap:4px; font-size:12px; margin-right:8px;">
                  <input type="${inputType}" name="meta_agency" value="${user.username}" ${checked}> 
                  ${esc(displayText)}
                </label>`;
    }).join('');
}
// ============================================================
// POPULATE activity CHECKLIST BUTTONS
// ============================================================
function populateactivityButtons() {
  const container = document.getElementById('activityChecklistButtons');
  if (!container) return;
  container.innerHTML = activityChecklists.map(hc => `
    <button type="button" class="btn btn-secondary" onclick="launchactivityChecklist('${hc.key}')">📋 ${hc.title}</button>
  `).join('');
}  
function getLinkedChecklistsForRfi(rfiNo) {
  return savedReports.filter(r => r.templateKey !== 'rfi' && (r.meta?.linkedRfi || '') === rfiNo);
}
function getLinkedNCRsForRfi(rfiNoOrId) {
  return savedReports.filter(r => r.templateKey === 'ncr' && (r.raisedFromRfi === rfiNoOrId || r.meta?.raisedFromRfi === rfiNoOrId));
}
function canAddChecklistToRfi(rec) {
  if (!rec) return false;
  return !['Approved', 'Approved with Comment', 'Rejected', 'Closed'].includes(rec.status || 'Draft');
}
function badgeForStatus(s) {
  const map = {
    'Approved': 'ok', 'Approved with Comment': 'mid', 'Rejected': 'bad',
    'Submitted': 'mid', 'Under Review': 'mid', 'Closed': 'ok', 'Draft': 'info',
    'Approved by Execution': 'mid', 'Open': 'mid'
  };
  const cls = map[s] || 'info';
  return `<span class="badge ${cls}">${esc(s || 'Draft')}</span>`;
}
function statusClass(v) {
  if (v === 'Yes') return 'select-yes';
  if (v === 'No') return 'select-no';
  if (v === 'NA') return 'select-na';
  return '';
}
function buildFormatNo(raw) {
  const m = String(raw || '').match(/(\d{2})\s*$/);
  const suffix = m ? m[1] : '01';
  return (appConfig.formatPrefix || 'QA / QC').trim() + ' / SITE / ' + suffix;
}
function getProjectDisplay() {
  const p = (appConfig.projectName || '').trim();
  const l = (appConfig.location || '').trim();
  if (p && l) return p + ' - ' + l;
  return p || l || 'Project Name - Location';
}

// ============================================================
// 7. NOTIFICATIONS (SERVER INTEGRATED)
// ============================================================
async function sendNotification(recipientUsername, message, type, rfiId, rfiNo, senderName) {
  try {
    await apiRequest('/api/notifications', {
      method: 'POST',
      body: JSON.stringify({
        recipient_username: recipientUsername,
        message,
        type: type || 'info',
        rfi_id: rfiId || '',
        rfi_no: rfiNo || '',
        sender_name: senderName || currentUser?.display || 'System'
      })
    });
    const notif = {
      id: 'notif_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      recipient_username: recipientUsername,
      message,
      type,
      rfi_id: rfiId || '',
      rfi_no: rfiNo || '',
      sender_name: senderName || currentUser?.display || 'System',
      read: 0,
      created_at: new Date().toISOString()
    };
    notifications.unshift(notif);
    if (notifications.length > 200) notifications = notifications.slice(0, 200);
    localStorage.setItem(NOTIFICATION_KEY, JSON.stringify(notifications));
    if (currentUser && currentUser.username === recipientUsername) {
      const iconMap = {
        'new_rfi': '🔔', 'approved': '✅', 'rejected': '❌', 'under_review': '🔍',
        'approved_comment': '📝', 'new_ncr': '📋', 'closed_ncr': '🔒',
        'approved_for_qa': '📋', 'ncr_open': '📤', 'ncr_submitted': '📩'
      };
      const icon = iconMap[type] || '📢';
      toast(icon + ' ' + message);
      if (Notification.permission === 'granted') {
        try { new Notification(icon + ' ' + message, { body: 'Click to open', icon: '🔔' }); } catch(e) {}
      }
      updateNotificationUI();
    }
  } catch(e) {
    console.warn('Failed to send notification', e);
  }
}

async function markNotificationRead(notifId) {
  try {
    await apiRequest(`/api/notifications/${notifId}/read`, { method: 'PUT' });
    const notif = notifications.find(n => n.id === notifId);
    if (notif) { notif.read = 1; }
    localStorage.setItem(NOTIFICATION_KEY, JSON.stringify(notifications));
    updateNotificationUI();
  } catch(e) {
    const notif = notifications.find(n => n.id === notifId);
    if (notif) { notif.read = 1; }
    localStorage.setItem(NOTIFICATION_KEY, JSON.stringify(notifications));
    updateNotificationUI();
  }
}

async function markAllNotificationsRead() {
  const unread = notifications.filter(n => n.recipient_username === currentUser?.username && !n.read);
  for (const n of unread) {
    try { await markNotificationRead(n.id); } catch(e) {}
  }
  toast('✅ All notifications marked as read');
}

function toggleNotifications() {
  const dropdown = document.getElementById('notifDropdown');
  dropdown.classList.toggle('open');
  if (dropdown.classList.contains('open')) renderNotificationList();
}

function updateNotificationUI() {
  if (!currentUser) { document.getElementById('notifContainer').style.display = 'none'; return; }
  document.getElementById('notifContainer').style.display = 'block';
  const count = notifications.filter(n => n.recipient_username === currentUser.username && !n.read).length;
  const badge = document.getElementById('notifBadge');
  if (count > 0) { badge.textContent = count > 99 ? '99+' : count; badge.classList.remove('hidden'); }
  else { badge.classList.add('hidden'); }
}

function renderNotificationList() {
  const list = document.getElementById('notifList');
  const userNotifs = notifications.filter(n => n.recipient_username === currentUser.username);
  if (userNotifs.length === 0) { list.innerHTML = '<div class="notif-empty">✨ No notifications yet</div>'; return; }
  list.innerHTML = userNotifs.map(n => `
    <div class="notif-item ${n.read ? '' : 'unread'}" onclick="handleNotificationClick('${n.id}', '${n.rfi_id}')">
      <div class="notif-icon">${getNotifIcon(n.type)}</div>
      <div class="notif-body">
        <div>${esc(n.message)}</div>
        <span class="notif-time">${fmtTimeAgo(n.created_at)}</span>
      </div>
      ${!n.read ? `<span class="notif-mark-read" onclick="event.stopPropagation();markNotificationRead('${n.id}')">✔</span>` : ''}
    </div>
  `).join('');
}

function getNotifIcon(type) {
  const map = {
    'new_rfi': '🔔', 'approved': '✅', 'rejected': '❌', 'under_review': '🔍',
    'approved_comment': '📝', 'new_ncr': '📋', 'closed_ncr': '🔒',
    'approved_for_qa': '📋', 'ncr_open': '📤', 'ncr_submitted': '📩'
  };
  return map[type] || '📢';
}

function handleNotificationClick(notifId, rfiId) {
  markNotificationRead(notifId);
  document.getElementById('notifDropdown').classList.remove('open');
  if (rfiId) openRecord(rfiId);
}

async function checkForNewNotifications() {
  if (!currentUser) return;
  try {
    const data = await apiRequest('/api/notifications');
    notifications = data;
    localStorage.setItem(NOTIFICATION_KEY, JSON.stringify(notifications));
    const unread = notifications.filter(n => !n.read);
    if (unread.length) {
      const latest = unread[0];
      const notifAge = Date.now() - new Date(latest.created_at).getTime();
      if (notifAge < 30000) {
        const icon = getNotifIcon(latest.type) || '📢';
        toast(icon + ' ' + latest.message);
        if (Notification.permission === 'granted') {
          try { new Notification(icon + ' ' + latest.message, { body: 'Click to open', icon: '🔔' }); } catch(e) {}
        }
      }
    }
    updateNotificationUI();
  } catch(e) {
    try { notifications = JSON.parse(localStorage.getItem(NOTIFICATION_KEY) || '[]'); } catch(e) {}
    updateNotificationUI();
  }
}

function startNotificationPolling() {
  if (notificationPollInterval) clearInterval(notificationPollInterval);
  if (!currentUser) return;
  if (Notification.permission === 'default') { Notification.requestPermission(); }
  setTimeout(checkForNewNotifications, 1000);
  notificationPollInterval = setInterval(checkForNewNotifications, 10000);
}

// ============================================================
// 8. STORAGE & SYNC – SERVER AS PRIMARY
// ============================================================

function loadDb() {
  try {
    savedReports = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch (e) {
    savedReports = [];
  }
  try {
    notifications = JSON.parse(localStorage.getItem(NOTIFICATION_KEY) || '[]');
  } catch (e) {
    notifications = [];
  }
}

// This function syncs a report to the server (POST or PUT)
async function syncReportToServer(row, isNew) {
  const siteName = getUserDefaultSite();
  const payload = toApiPayload(row, siteName);
  console.log('🔍 [DEBUG] Sending payload:', payload);
  if (row.templateKey === 'audit') {
    console.log('🔍 [DEBUG] Audit payload agency:', payload.meta.agency);
  }
  if (isNew) {
    await apiRequest('/api/reports', { method: 'POST', body: JSON.stringify(payload) });
  } else {
    await apiRequest(`/api/reports/${row.id}`, { method: 'PUT', body: JSON.stringify(payload) });
  }

  // --- Store only metadata in localStorage, same as loadFromServer ---
  // First, update the existing row in savedReports
  const idx = savedReports.findIndex(r => r.id === row.id);
  if (idx >= 0) {
    // Keep the existing attachments (which are metadata-only) – but if the row has full attachments, strip data
    const existingAttachments = savedReports[idx].attachments || [];
    row.attachments = row.attachments.map(a => ({ name: a.name, type: a.type })); // strip base64
    savedReports[idx] = row;
  } else {
    // New row – strip attachments
    row.attachments = row.attachments.map(a => ({ name: a.name, type: a.type }));
    savedReports.unshift(row);
  }

  // Keep only latest 50
  savedReports.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
  savedReports = savedReports.slice(0, 50);

  localStorage.setItem(STORAGE_KEY, JSON.stringify(savedReports));
  updateStats(); renderHistory(); updateNotificationUI();
}

// ★★★★★  INSERT loadFromServer HERE (right after syncReportToServer)  ★★★★★
async function loadFromServer() {
  try {
    const data = await apiRequest('/api/data');
    console.log('🔍 [DEBUG] Server data:', data);

    // --- Build reports WITHOUT attachment data (only metadata) ---
    let reports = (data.reports || []).map(r => {
      let meta = r.meta || {};
      if (r.template_key === 'audit' && meta.agency) {
        if (typeof meta.agency === 'string') {
          try {
            const parsed = JSON.parse(meta.agency);
            meta.agency = Array.isArray(parsed) ? parsed : [meta.agency];
          } catch {
            meta.agency = [meta.agency];
          }
        } else if (!Array.isArray(meta.agency)) {
          meta.agency = [meta.agency];
        }
      }

      return {
        id: r.id,
        templateKey: r.template_key,
        templateName: r.template_name,
        formatNo: r.format_no,
        meta: meta,
        sections: r.sections || [],
        score: r.score || 0,
        defectsCount: r.defects_count || 0,
        titleLoc: r.title_loc || '',
        preparedBy: r.prepared_by || '',
        status: r.status || 'Draft',
        comment: r.comment || '',
        // ⚠️ Store ONLY name and type, NOT data (to save space)
        attachments: (r.attachments || []).map(a => ({
          name: a.name,
          type: a.type
          // data: a.data   // ← intentionally omitted
        })),
        createdBy: r.created_by || '',
        createdByDisplay: r.created_by_display || '',
        decisionBy: r.decision_by || '',
        decisionByDisplay: r.decision_by_display || '',
        savedAt: r.saved_at || '',
        audit: r.audit || [],
        raisedFromRfi: r.raised_from_rfi || '',
        siteName: r.site_name || ''
      };
    });

    // --- Keep only the latest 50 reports (by savedAt) ---
    reports.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
    savedReports = reports.slice(0, 50);

    notifications = data.notifications || [];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedReports));
    localStorage.setItem(NOTIFICATION_KEY, JSON.stringify(notifications));
    renderHistory(); updateStats(); updateNotificationUI();
    toast('✅ Synced with server');
  } catch (e) {
    if (e.name === 'QuotaExceededError' || e.code === 22) {
      toast('⚠️ Local storage is full. Please clear cache or delete old reports.');
      console.warn('QuotaExceededError:', e);
    } else if (e.message && e.message.includes('401')) {
      throw e;
    } else {
      console.warn('Server offline, using cached data', e);
      toast('⚠️ Using cached data (server unavailable)');
    }
    loadDb();
    renderHistory(); updateStats(); updateNotificationUI();
  }
}


// ============================================================
// 9. CONFIG / MASTERS (localStorage only – no server needed)
// ============================================================
function loadConfig() {
  try { appConfig = { ...appConfig, ...JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}') }; } catch(e) {}
}
function saveConfig(ev) {
  ev.preventDefault();
  appConfig = {
    companyName: document.getElementById('cfgCompanyName').value.trim() || 'QA/QC Suite',
    projectName: document.getElementById('cfgProjectName').value.trim() || 'Project Name',
    location: document.getElementById('cfgLocation').value.trim() || 'Location',
    formatPrefix: document.getElementById('cfgFormatPrefix').value.trim() || 'QA / QC',
    businessPackage: document.getElementById('cfgBusinessPackage').value.trim() || 'Site Formats',
    ncrCounter: appConfig.ncrCounter || 1
  };
  localStorage.setItem(CONFIG_KEY, JSON.stringify(appConfig));
  applyConfig(); toast('✅ Configuration saved');
}
 function resetConfig() {
  appConfig = { companyName: 'QA/QC Suite', projectName: 'Project Name', location: 'Location', formatPrefix: 'QA / QC', businessPackage: 'Site Formats', ncrCounter: 1, imirCounter: 1 };
  localStorage.setItem(CONFIG_KEY, JSON.stringify(appConfig));
  populateConfigForm(); applyConfig(); toast('↩️ Configuration reset');
}
function loadMasters() {
  try { masters = { disciplines: ['Civil', 'Mechanical', 'Electrical'], ...JSON.parse(localStorage.getItem(MASTER_KEY) || '{}') }; } catch(e) {}
}
function saveMasters(ev) {
  ev.preventDefault();
  const val = document.getElementById('mstDisciplines').value || '';
  masters.disciplines = val.split(',').map(s => s.trim()).filter(Boolean);
  localStorage.setItem(MASTER_KEY, JSON.stringify(masters));
  toast('✅ Master data saved');
}
function resetMasters() {
  masters = { disciplines: ['Civil', 'Mechanical', 'Electrical'] };
  localStorage.setItem(MASTER_KEY, JSON.stringify(masters));
  populateMastersForm(); toast('↩️ Master data reset');
}
function loadSession() { try { currentUser = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch(e) { currentUser = null; } }
function saveSession() { localStorage.setItem(SESSION_KEY, JSON.stringify(currentUser)); }

// ============================================================
// 10. AUTH (API) – unchanged
// ============================================================
async function login() {
  const username = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value;
  try {
    const res = await fetch(`${API_BASE}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    if (!res.ok) {
      const err = await res.json();
      toast('❌ ' + (err.error || 'Login failed'));
      return;
    }
    const data = await res.json();
    const { token, user } = data;
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    currentUser = user;
    document.querySelectorAll('.auth-only').forEach(el => el.classList.remove('hidden'));
    // Show admin-only items if user is admin
document.querySelectorAll('.admin-only').forEach(el => {
  el.style.display = currentUser && currentUser.role === 'admin' ? 'block' : 'none';
});
    // Show manager/admin items if user is admin or manager
document.querySelectorAll('.manager-admin-only').forEach(el => {
  el.style.display = currentUser && (currentUser.role === 'admin' || currentUser.role === 'manager') ? 'block' : 'none';
});
// --- END ADD ---

    renderCards();
    await loadFromServer();
    // --- Subscribe to push notifications (if permission granted) ---
    if (Notification.permission === 'granted') {
      await subscribeToPush( );
    }
    // --- end push subscription ---
    updateStats();
    updateNotificationUI();
    startNotificationPolling();
    applyFiltersAndRefresh();
    switchView('dashboard');
    setActiveKpiCard('total');
    toast('✅ Welcome ' + (user.full_name || user.username));
    const unread = notifications.filter(n => n.recipient_username === user.username && !n.read).length;
    if (unread > 0) toast('🔔 You have ' + unread + ' unread notification' + (unread > 1 ? 's' : ''));
  } catch(e) {
    toast('⚠️ Login failed, trying cached session...');
    const cachedUser = JSON.parse(localStorage.getItem('user') || 'null');
    if (cachedUser) {
      currentUser = cachedUser;
      toast('⚠️ Using cached session (server unavailable)');
      document.querySelectorAll('.auth-only').forEach(el => el.classList.remove('hidden'));
      loadDb();
      renderCards();
      updateStats();
      updateNotificationUI();
      startNotificationPolling();
      switchView('dashboard');
      toast('⚠️ Using offline mode - data may be outdated');
    } else {
      toast('❌ Network error: ' + e.message);
    }
  }
}
// ============================================================
// REGISTRATION
// ============================================================

async function registerUser(ev) {
  ev.preventDefault();
  
  const email = document.getElementById('regEmail').value.trim();
  const full_name = document.getElementById('regFullName').value.trim();
  const role = document.getElementById('regRole').value;
  const assigned_sites_input = document.getElementById('regSites').value.trim();
  const password = document.getElementById('regPassword').value;

  // Basic validation
  if (!email || !password || !full_name || !role) {
    toast('⚠️ Please fill all required fields');
    return;
  }

  // Simple email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    toast('⚠️ Please enter a valid email address');
    return;
  }

  // Password strength check (minimum 6 characters)
  if (password.length < 6) {
    toast('⚠️ Password must be at least 6 characters');
    return;
  }

 // Get selected sites from dropdown
const siteSelect = document.getElementById('regSites');
const assigned_sites = Array.from(siteSelect.selectedOptions).map(opt => opt.value);

  try {
    const res = await fetch(`${API_BASE}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        email, 
        password, 
        full_name, 
        role, 
        assigned_sites 
      })
    });
    
    const data = await res.json();
    
    if (!res.ok) {
      toast('❌ ' + (data.error || 'Registration failed'));
      return;
    }
    
    toast('✅ ' + data.message);
    
    // Clear the form
    document.getElementById('registerForm').reset();
    
    // Switch to login view
    switchView('login');
    
    // Pre-fill the login email field
    document.getElementById('loginUser').value = email;
    
  } catch (err) {
    toast('❌ Network error: ' + err.message);
  }
}
// ← PASTE HERE ↓↓↓
async function loadSites() {
  try {
    const res = await fetch(`${API_BASE}/api/sites`);
    const sites = await res.json();
    const select = document.getElementById('regSites');
    if (select) {
      select.innerHTML = sites.map(s => `<option value="${s}">${s}</option>`).join('');
    }
  } catch (e) {
    console.warn('Could not load sites', e);
  }
}
// ============================================================
// LOAD AGENCY USERS (for Audit/NCR selection) – with filtering & enrichment
// ============================================================
async function loadAgencyUsers() {
  try {
    const users = await apiRequest('/api/users/agency');
    // users is array of objects – guess field names
    let filtered = users.filter(u => {
      const role = u.role || u.role_name || '';
      return role === 'engineer' || role === 'exec_engineer';
    });

    // Apply site-based filtering
    if (currentUser && (currentUser.role === 'exec_engineer' || currentUser.role === 'qa_head')) {
      const userSites = currentUser.assigned_sites || [];
      if (userSites.length > 0) {
        filtered = filtered.filter(u => {
          const uSites = u.assigned_sites || u.sites || [];
          return uSites.some(s => userSites.includes(s));
        });
      }
    }

    // Normalise each user – try multiple field names
   agencyUsers = filtered.map(u => ({
  id: u.id,
  // ★★★ The server returns the username as 'u' ★★★
  username: u.u || u.username || u.user || u.email || u.id,
  displayName: u.name || u.full_name || u.display_name || u.fullname || u.username || u.user || 'Unknown',
  role: u.role || u.role_name || '',
  sites: u.assigned_sites || u.sites || []
}));

    console.log('✅ Agency users loaded (filtered):', agencyUsers.length);
  } catch (e) {
    console.warn('Failed to load agency users:', e);
    // Fallback to static users (make sure they have name and u)
    agencyUsers = users.filter(u => u.role === 'engineer' || u.role === 'exec_engineer').map(u => ({
      id: u.id,
      username: u.u || u.username || u.id,
      displayName: u.name || u.full_name || u.u,
      role: u.role,
      sites: u.assigned_sites || []
    }));
  }
}
// ============================================================
// SITE MANAGEMENT (Admin only)
// ============================================================

async function loadSiteList() {
  try {
    const res = await fetch(`${API_BASE}/api/sites`);
    if (!res.ok) throw new Error('Failed to load sites');
    const sites = await res.json();
    const list = document.getElementById('siteList');
    if (list) {
      list.innerHTML = sites.map(s => `
        <li style="display:flex; justify-content:space-between; align-items:center; padding:8px 12px; border-bottom:1px solid var(--line);">
          <span>${s}</span>
          <button class="btn btn-danger" style="padding:4px 10px; font-size:12px;" onclick="deleteSite('${s}')">Delete</button>
        </li>
      `).join('');
    }
  } catch (e) {
    console.warn('Could not load site list:', e);
  }
}

async function addSite() {
  const input = document.getElementById('newSiteName');
  const name = input.value.trim();
  if (!name) return toast('⚠️ Please enter a site name');
  try {
    const token = localStorage.getItem('token');
    const res = await fetch(`${API_BASE}/api/sites`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ name })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to add site');
    toast('✅ Site added');
    input.value = '';
    loadSiteList();
    loadSites();
  } catch (e) {
    toast('❌ ' + e.message);
  }
}

async function deleteSite(name) {
  if (!confirm(`Delete site "${name}"?`)) return;
  try {
    const token = localStorage.getItem('token');
    const res = await fetch(`${API_BASE}/api/sites/${name}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to delete site');
    toast('✅ Site deleted');
    loadSiteList();
    loadSites();
  } catch (e) {
    toast('❌ ' + e.message);
  }
}

// ============================================================
// USER MANAGEMENT (Admin only)
// ============================================================

async function loadUsers() {
  try {
    const users = await apiRequest('/api/users/all');
    const tbody = document.getElementById('userListBody');
    if (!tbody) return;
    
    if (users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="kpi-empty">No users registered yet.</td></tr>';
      return;
    }
    
    tbody.innerHTML = users.map(u => {
      const isPending = !u.approved;
      const statusBadge = isPending 
        ? '<span class="badge warn">⏳ Pending</span>' 
        : '<span class="badge ok">✅ Approved</span>';
      
      let actionButtons = isPending
        ? `<button class="btn btn-ok" style="padding:4px 10px; font-size:11px;" onclick="approveUser(${u.id})">Approve</button>`
        : '';
      actionButtons += ` <button class="btn btn-danger" style="padding:4px 10px; font-size:11px;" onclick="deleteUser(${u.id})">Delete</button>`;
      
      const sites = Array.isArray(u.assigned_sites) ? u.assigned_sites.join(', ') : '-';
      const roleMap = {
        'engineer': '👷 Contractor',
        'exec_engineer': '🔧 Execution Engineer',
        'qa_head': '👔 QA Head',
        'manager': '📊 Manager',
        'admin': '🔧 Admin',
        'consultant': '👀 Consultant'
      };
      
      return `
        <tr>
          <td><b>${esc(u.full_name || u.username)}</b></td>
          <td>${esc(u.email || u.username)}</td>
          <td>${roleMap[u.role] || u.role}</td>
          <td>${esc(sites)}</td>
          <td>${statusBadge}</td>
          <td>${fmtDateTime(u.created_at)}</td>
          <td>${actionButtons}</td>
        </tr>
      `;
    }).join('');
  } catch (e) {
    console.error('Failed to load users:', e);
    const tbody = document.getElementById('userListBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="kpi-empty">Failed to load users.</td></tr>';
  }
}

async function approveUser(id) {
  if (!confirm('Approve this user?')) return;
  try {
    await apiRequest(`/api/users/${id}/approve`, { method: 'PUT' });
    toast('✅ User approved');
    loadUsers();
  } catch (e) {
    toast('❌ ' + e.message);
  }
}

async function deleteUser(id) {
  if (!confirm('Delete this user?')) return;
  try {
    await apiRequest(`/api/users/${id}`, { method: 'DELETE' });
    toast('✅ User deleted');
    loadUsers();
  } catch (e) {
    toast('❌ ' + e.message);
  }
}

// ============================================================
// LOGOUT & PERMISSION HELPERS
// ============================================================

function logout() {
  if (notificationPollInterval) { clearInterval(notificationPollInterval); notificationPollInterval = null; }
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  currentUser = null;
  document.querySelectorAll('.auth-only').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'none');
  document.querySelectorAll('.manager-admin-only').forEach(el => el.style.display = 'none'); // ← ADD THIS
  document.getElementById('notifContainer').style.display = 'none';
  globalFilterState = { project: '', type: '', contractor: '', discipline: '', status: '', fromDate: '', toDate: '', owner: '' };
  switchView('login');
  toast('👋 Logged out');
}

function canApprove() { return currentUser && (currentUser.role === 'qa_head' || currentUser.role === 'admin'); }
function isExecEngineer() { return currentUser && currentUser.role === 'exec_engineer'; }
function canSeeAll() { return currentUser && (currentUser.role === 'qa_head' || currentUser.role === 'admin' || currentUser.role === 'manager' || currentUser.role === 'consultant' || currentUser.role === 'exec_engineer'); }
function canDeleteRecord(rec) { return currentUser && (currentUser.role === 'admin' || currentUser.role === 'qa_head' || rec?.createdBy === currentUser.username); }

// ============================================================
// 11. VISIBILITY LOGIC (FIXED NCR MATCHING)
// ============================================================
function canUserSeeRecord(record, user) {
  if (!user) return false;
  if (!record) return false;

  // 1. Owner always sees their own records
  if (record.createdBy === user.username) return true;

  // 2. Admin sees everything
  if (user.role === 'admin') return true;

  // 3. For RFI records, give QA Head an extra exception
  if (user.role === 'qa_head' && record.templateKey === 'rfi') {
    const rfiId = record.id;
    const rfiNo = record.meta?.rfiNo || '';
    const hasNcr = savedReports.some(r =>
      r.templateKey === 'ncr' &&
      r.createdBy === user.username &&
      (r.raisedFromRfi === rfiId || r.raisedFromRfi === rfiNo || r.meta?.raisedFromRfi === rfiId || r.meta?.raisedFromRfi === rfiNo)
    );
    if (hasNcr) return true;
  }

  // 4. For non-RFI records (checklists, NCRs, IMIRs, Audits)
  if (record.templateKey !== 'rfi') {
    // Linked RFI logic (checklists, NCRs, IMIRs)
    let linkedRfiId = record.raisedFromRfi || record.meta?.raisedFromRfi || record.meta?.linkedRfi || '';
    if (linkedRfiId) {
      const parentRfi = savedReports.find(r =>
        r.templateKey === 'rfi' &&
        (r.id === linkedRfiId || r.meta?.rfiNo === linkedRfiId)
      );
      if (parentRfi) {
        if (parentRfi.createdBy === user.username) return true;
        return canUserSeeRecord(parentRfi, user);
      }
    }

    // --- NCR visibility ---
   if (record.templateKey === 'ncr' && 
    (user.role === 'engineer' || user.role === 'exec_engineer')) {
  const agency = record.meta?.agency;
  // If it's a string (old data), compare directly; if array, check includes
  if (Array.isArray(agency) && agency.includes(user.username)) {
    return true;
  }
  if (typeof agency === 'string' && agency === user.username) {
    return true;
  }
  return false;
}
 // --- AUDIT visibility (only for selected agencies) ---
if (record.templateKey === 'audit') {
  console.log('🔍 [canUserSeeRecord] audit id:', record.id);
  console.log('  - agency list:', record.meta?.agency);
  console.log('  - current user:', user.username);

  // Managers and consultants see all audits
  if (user.role === 'manager' || user.role === 'consultant') {
    return true;
  }

  const agencies = record.meta?.agency;
  let agencyList = agencies;
  if (typeof agencies === 'string') {
    try {
      const parsed = JSON.parse(agencies);
      agencyList = Array.isArray(parsed) ? parsed : [agencies];
    } catch {
      agencyList = [agencies];
    }
  }
  if (Array.isArray(agencyList) && agencyList.includes(user.username)) {
    return true;
  }
  return false;
}

    // For other non-RFI records (checklists, IMIRs, etc.) – only managers, consultants, QA heads, exec engineers can see
    return user.role === 'manager' || user.role === 'consultant' || user.role === 'qa_head' || user.role === 'exec_engineer';
  }

  // 5. RFI routing logic (unchanged)
  if (user.role === 'manager' || user.role === 'consultant') {
    return true;
  }
  const routing = record.meta?.routing || 'Execution Engineer → QA Head';
  const status = record.status || 'Draft';
  if (routing === 'Direct to QA Head') {
    return user.role === 'qa_head';
  } else if (routing === 'Execution Engineer → QA Head') {
    if (user.role === 'exec_engineer') return true;
    if (user.role === 'qa_head' && status === 'Approved by Execution') return true;
    return false;
  } else if (routing === 'Both') {
    return user.role === 'qa_head' || user.role === 'exec_engineer';
  }
  return false;
}
 function getSavedRecordFilterState() {
  return {
    project: document.getElementById('fltProject')?.value || '',
    type: document.getElementById('fltType')?.value || '',
    contractor: document.getElementById('fltContractor')?.value || '',
    discipline: document.getElementById('fltDiscipline')?.value || '',
    status: document.getElementById('fltStatus')?.value || '',
    fromDate: document.getElementById('fltDateFrom')?.value || '',
    toDate: document.getElementById('fltDateTo')?.value || '',
    owner: document.getElementById('fltOwner')?.value || ''
  };
}
function applyFiltersAndRefresh() {
  globalFilterState = getSavedRecordFilterState();
  updateStats();
  renderHistory();
  if (document.getElementById('view-dashboard').classList.contains('active')) {
    if (currentKpiFilter) filterKPI(currentKpiFilter);
  }
}
function updateAdminToolsVisibility() {
  const box = document.getElementById('adminToolsBox');
  if (box) box.classList.toggle('hidden', !(currentUser && currentUser.role === 'admin'));
}

// ============================================================
// 12. REFRESH FUNCTION
// ============================================================
function refreshHistory() {
  globalFilterState = {
    project: '', type: '', contractor: '', discipline: '',
    status: '', fromDate: '', toDate: '', owner: ''
  };
  const fields = ['fltProject', 'fltType', 'fltContractor', 'fltDiscipline', 'fltStatus', 'fltDateFrom', 'fltDateTo', 'fltOwner'];
  fields.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      if (el.tagName === 'SELECT') el.value = '';
      else el.value = '';
    }
  });
  loadFromServer().then(() => {
    renderHistory();
    toast('✅ Records refreshed');
  }).catch(() => {
    loadDb();
    renderHistory();
    toast('⚠️ Using cached data');
  });
}

// ============================================================
// 13. VIEWS, CARDS, FORM RENDERING – unchanged
// ============================================================
function applyConfig() {
  document.getElementById('brandTitle').innerText = appConfig.companyName || 'QA/QC Suite';
  document.getElementById('brandSub').innerText = appConfig.businessPackage || 'Site Formats';
  document.getElementById('sheetOrg').innerText = appConfig.companyName || 'QA/QC Suite';
  const cleanName = (appConfig.companyName || 'QA/QC Suite').replace(/\s*Inspection Suite$/i, '').replace(/\s*Suite$/i, '').trim() || 'QA/QC';
  document.getElementById('appTitle').innerText = cleanName + ' Inspection Suite';
  document.getElementById('appSub').innerText = getProjectDisplay();
}
function populateConfigForm() {
  document.getElementById('cfgCompanyName').value = appConfig.companyName || '';
  document.getElementById('cfgProjectName').value = appConfig.projectName || '';
  document.getElementById('cfgLocation').value = appConfig.location || '';
  document.getElementById('cfgFormatPrefix').value = appConfig.formatPrefix || '';
  document.getElementById('cfgBusinessPackage').value = appConfig.businessPackage || '';
}
function populateMastersForm() {
  document.getElementById('mstDisciplines').value = (masters.disciplines || []).join(', ');
}
function switchView(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const pane = document.getElementById('view-' + view);
  if (pane) pane.classList.add('active');
  document.querySelectorAll('.menu-item').forEach(v => v.classList.remove('active'));
  const menu = document.querySelector('.menu-item[data-target="' + view + '"]');
  if (menu) menu.classList.add('active');
  if (view !== 'form' && view !== 'login') previousView = view;
  const badge = document.getElementById('viewBadge');
  if (badge) {
    if (currentUser) {
      const roleMap = {
        engineer: '👷 Contractor',
        exec_engineer: '🔧 Execution Engineer',
        qa_head: '👔 QA Head',
        manager: '📊 Manager',
        admin: '🔧 Admin',
        consultant: '👀 Consultant'
      };
      badge.innerText = roleMap[currentUser.role] || 'System Active';
    } else { badge.innerText = '🔒 Not Logged In'; }
  }
 if (view === 'dashboard') {
  // --- Lazy load Chart.js only when dashboard is viewed ---
  if (typeof Chart === 'undefined') {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/chart.js';
    script.async = true;
    script.onload = function() {
      renderRfiChart('rfi');
    };
    document.head.appendChild(script);
  } else {
    renderRfiChart('rfi');
  }
  updateStats();
  renderCards();
  if (currentKpiFilter) filterKPI(currentKpiFilter);
}
  if (view === 'history') { renderHistory(); }
  if (view === 'settings') { populateConfigForm(); updateAdminToolsVisibility(); }
  if (view === 'masters') { populateMastersForm(); }
  if (view === 'login') {
    document.getElementById('appTitle').innerText = 'QA/QC Inspection Suite';
    document.getElementById('appSub').innerText = 'Secure Access';
  }
  if (view === 'auditdashboard') { 
    updateAuditStats(); 
    renderAuditHistory(); 
    if (currentAuditKpiFilter) filterAuditKPI(currentAuditKpiFilter); 
    // REMOVED: renderAuditRecords() - now on its own page
  }
  if (view === 'auditrecords') { 
    renderAuditRecords('auditRecordsBodyV2', 'auditRecordCountBadgeV2'); 
  }
  if (view === 'register') { loadSites(); }
  if (view === 'sites') { loadSiteList(); }
  if (view === 'users') { loadUsers(); }
  if (view === 'about') { /* nothing needed */ }
  updateNotificationUI();
}
// ============================================================
// GO BACK FROM ABOUT
// ============================================================
function goBackFromAbout() {
  // If user is logged in, go to dashboard
  if (currentUser) {
    switchView('dashboard');
  } else {
    // If not logged in, go to login
    switchView('login');
  }
}
// ============================================================
// REFRESH CURRENT RECORD – fetch latest from server
// ============================================================
function refreshCurrentRecord() {
  if (!activeReportId) {
    toast('⚠️ No record is currently open.');
    return;
  }
  toast('🔄 Refreshing record from server...');
  // Re‑open the record, which will fetch the latest data including attachments
  openRecord(activeReportId);
}
function backFromForm() {
  if (pendingReturnRfiId) {
    const record = savedReports.find(r => r.id === pendingReturnRfiId);
    if (record) {
      // Clear pending ID so we don't loop back again
      const id = pendingReturnRfiId;
      pendingReturnRfiId = null;
      openTemplate(record.templateKey, id);
      return;
    }
  }
  switchView(previousView || 'dashboard');
}
function renderCards() {
  const host = document.getElementById('templateCards');
  host.innerHTML = '';
  const flt = document.getElementById('fltType');
  if (flt) {
    flt.innerHTML = '<option value="">All</option>' +
      Object.entries(templates).map(([k, t]) => `<option value="${esc(k)}">${esc(t.menuTitle)}</option>`).join('');
  }
  const isExec = isExecEngineer();
  Object.entries(templates).forEach(([k, t]) => {
    if (isExec && k === 'rfi') return;
    if (k === 'audit') return;   // ← hide Project Audit from main Dashboard
     if (k.startsWith('activity_')) return;   // ← ADD THIS
    const c = document.createElement('div');
    c.className = 'card';
    c.innerHTML = `
      <h3>📄 ${esc(t.menuTitle)}</h3>
      <p>${esc(t.summary)}</p>
      <div class="foot">
        <span>${esc(t.formatNo)}</span>
        <span>${t.menuTitle === 'RFI' ? '10 lines' : t.menuTitle === 'NCR' ? '20 lines' : t.menuTitle === 'IMIR' ? '15 lines' : '19 lines'}</span>
      </div>`;
    c.onclick = () => openTemplate(k);
    host.appendChild(c);
  });
}
function makeInput(id, value, type = 'text', options = []) {
  if (type === 'select') {
    const vals = options.length ? options : (id === 'meta_discipline' ? masters.disciplines : []);
    return `<select class="value-input" id="${id}">${vals.map(v => `<option value="${esc(v)}" ${String(value) === String(v) ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>`;
  }
  if (type === 'radio') {
    const show = currentUser && (currentUser.role === 'engineer' || currentUser.role === 'admin');
    if (!show) return '<span class="small">(Routing not applicable)</span>';
    return `<div class="radio-line">${options.map(o => `<label><input type="radio" name="meta_routing" value="${esc(o)}" ${String(value) === String(o) ? 'checked' : ''}> ${esc(o)}</label>`).join('')}</div>`;
  }
  return `<input type="${type}" class="value-input" id="${id}" value="${esc(value || '')}">`;
}
function renderMetaRows(metaRows, metaData = {}) {
  let html = '<table class="sheet-table">';
  metaRows.forEach(row => {
    html += '<tr>';
    row.forEach(cell => {
      let val = metaData[cell.k] !== undefined ? metaData[cell.k] : (cell.d || '');
      let type = cell.t || 'text';
      let opts = cell.options || [];
      if (cell.k === 'discipline') {
        type = 'select'; opts = masters.disciplines.length ? masters.disciplines : ['Civil', 'Mechanical', 'Electrical'];
        if (!val) val = opts[0] || '';
      }
      if (cell.k === 'linkedRfi') {
        type = 'select'; opts = getRfiOptions();
        if (!val && opts.length) val = opts[0] || '';
      }
      // --- NEW: Agency dropdown for NCR (filtered by site) ---
      if (cell.k === 'agency' && activeTemplateKey === 'ncr') {
        type = 'select';
        let engineers = users.filter(u => u.role === 'engineer');
        const userSites = currentUser?.assigned_sites || ['*'];
        if (!userSites.includes('*')) {
          engineers = engineers.filter(e => {
            if (!e.assigned_sites) return false;
            return e.assigned_sites.some(s => userSites.includes(s));
          });
        }
        opts = engineers.map(u => u.u);
        if (val && !opts.includes(val)) {
          opts.push(val);
        }
      }
      // --- end of new code ---

      html += `<td class="label-cell">${esc(cell.l)}</td><td>${makeInput('meta_' + cell.k, val, type, opts)}</td>`;
    });
    if (row.length === 1) html += '<td colspan="2"></td>';
    html += '</tr>';
  });
  return html + '</table>';
}
function renderSimpleCheck(sec, secData = {}) {
  let html = `<table class="sheet-table"><tr><th colspan="5">${esc(sec.title)}</th></tr><tr><th>Check Item</th><th>Contractor</th><th>Company</th><th>Remarks</th><th>Status</th></tr>`;
  sec.items.forEach((it, i) => {
    const row = secData.items?.[i] || {};
    html += `<tr>
      <td>${esc(it)}</td>
      <td><input class="table-input" value="${esc(row.contractor || '')}"></td>
      <td><input class="table-input" value="${esc(row.company || '')}"></td>
      <td><input class="table-input" value="${esc(row.remarks || '')}"></td>
      <td><select class="status-select ${statusClass(row.status)}" onchange="stylizeStatus(this);updateProgress()">
        <option value=""></option>
        <option value="Yes" ${row.status === 'Yes' ? 'selected' : ''}>Yes</option>
        <option value="No" ${row.status === 'No' ? 'selected' : ''}>No</option>
        <option value="NA" ${row.status === 'NA' ? 'selected' : ''}>NA</option>
      </select></td>
    </tr>`;
  });
  return html + '</table>';
}
function renderChecklist(sec, secData = {}) {
  let html = `<table class="sheet-table"><tr>${sec.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr>`;
  let itemIndex = 0, sr = 1;
  sec.groups.forEach(g => {
    html += `<tr class="check-section-row"><td colspan="4">${esc(g.name)}</td></tr>`;
    g.items.forEach(item => {
      const row = secData.items?.[itemIndex] || {};
      html += `<tr>
        <td style="width:8%;text-align:center;">${sr++}</td>
        <td>${esc(item)}</td>
        <td style="width:18%;"><select class="status-select ${statusClass(row.status)}" onchange="stylizeStatus(this);updateProgress()">
          <option value=""></option>
          <option value="Yes" ${row.status === 'Yes' ? 'selected' : ''}>Yes</option>
          <option value="No" ${row.status === 'No' ? 'selected' : ''}>No</option>
          <option value="NA" ${row.status === 'NA' ? 'selected' : ''}>NA</option>
        </select></td>
        <td style="width:24%;"><textarea class="table-textarea">${esc(row.remarks || '')}</textarea></td>
      </tr>`;
      itemIndex++;
    });
  });
  return html + '</table>';
}
function renderTable(sec, secData = {}) {
  let html = `<table class="sheet-table"><tr><th colspan="${sec.columns.length}">${esc(sec.title)}</th></tr><tr>${sec.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr>`;
  const rows = secData.rows || [];
  for (let r = 0; r < sec.rows; r++) {
    const row = rows[r] || [];
    html += '<tr>' + sec.columns.map((c, ci) => `<td><input class="table-input" value="${esc(row[ci] ?? (ci === 0 ? r + 1 : ''))}"></td>`).join('') + '</tr>';
  }
  return html + '</table>';
}
function renderAccepted(sec, secData = {}) {
  let html = `<table class="sheet-table"><tr><th colspan="4">${esc(sec.title)}</th></tr><tr><th>Role</th><th>Name</th><th>Signature</th><th>Date</th></tr>`;
  sec.rows.forEach((role, i) => {
    const row = secData.rows?.[i] || {};
    html += `<tr>
      <td>${esc(role)}</td>
      <td><input class="table-input" value="${esc(row.name || '')}"></td>
      <td><input class="table-input" value="${esc(row.sign || '')}"></td>
      <td><input type="date" class="table-input" value="${esc(row.date || '')}"></td>
    </tr>`;
  });
  return html + '</table>';
}
function renderStatus(sec, secData = {}, si) {
  const val = secData.value || '';
  return `<table class="sheet-table"><tr><th>${esc(sec.title)}</th></tr><tr><td><div class="radio-line">${sec.options.map(o => `<label><input type="radio" name="status_${si}" value="${esc(o)}" ${val === o ? 'checked' : ''}> ${esc(o)}</label>`).join('')}</div></td></tr></table>`;
}
function renderTextarea(sec, secData = {}) {
  return `<table class="sheet-table"><tr><th>${esc(sec.title)} ${sec.note ? `<span class="small">${esc(sec.note)}</span>` : ''}</th></tr><tr><td><textarea class="plain-textarea">${esc(secData.value || '')}</textarea></td></tr></table>`;
}
function renderDate(sec, secData = {}, key) {
  const val = secData[key] || '';
  return `<table class="sheet-table"><tr><th>${esc(sec.title)}</th></tr><tr><td><input type="date" class="value-input" id="meta_${key}" value="${esc(val)}"></td></tr></table>`;
}
function renderSignatures(sec, secData = {}) {
  let html = `<table class="sheet-table"><tr>${sec.roles.map(r => `<th>${esc(r)}</th>`).join('')}</tr><tr>`;
  sec.roles.forEach((r, ri) => {
    const e = secData.entries?.[ri] || {};
    html += `<td><div style="display:grid;gap:8px;"><div><b>Name :</b> <input class="sig-input" value="${esc(e.name || '')}"></div><div><b>Signature :</b> <input class="sig-input" value="${esc(e.sign || '')}"></div><div><b>Date :</b> <input type="date" class="sig-input" value="${esc(e.date || '')}"></div></div></td>`;
  });
  return html + '</tr></table>';
}
function renderText(sec, secData = {}) {
  const val = secData[sec.k] || '';
  return `<table class="sheet-table"><tr><th>${esc(sec.title)}</th></tr><tr><td><input class="value-input" id="meta_${sec.k}" value="${esc(val)}"></td></tr></table>`;
}
function stylizeStatus(sel) {
  sel.classList.remove('select-yes', 'select-no', 'select-na');
  if (sel.value === 'Yes') sel.classList.add('select-yes');
  else if (sel.value === 'No') sel.classList.add('select-no');
  else if (sel.value === 'NA') sel.classList.add('select-na');
}
function renderSheet(t, report) {
  const body = document.getElementById('sheetBody');
   // --- ADD THIS BLOCK ---
  const sheetHead = document.querySelector('.sheet-head');
  const sheetShell = document.querySelector('.sheet-shell');
  
  const exactFormats = ['audit', 'ncr', 'imir'];
  if (exactFormats.includes(activeTemplateKey)) {
    if (sheetHead) sheetHead.style.display = 'none';
    if (sheetShell) {
      sheetShell.style.borderRadius = '0';
      sheetShell.style.padding = '0';
      sheetShell.style.background = 'transparent';
      sheetShell.style.border = 'none';
      sheetShell.style.boxShadow = 'none';
    }
  } else {
    if (sheetHead) sheetHead.style.display = 'block';
    if (sheetShell) {
      sheetShell.style.borderRadius = '14px';
      sheetShell.style.padding = '18px';
      sheetShell.style.background = 'var(--card)';
      sheetShell.style.border = '1px solid var(--line)';
      sheetShell.style.boxShadow = '0 8px 22px rgba(18,58,102,.08)';
    }
  }
  // --- END OF ADDED BLOCK ---
  const meta = report?.meta || {};
  const sectionsData = report?.sections || [];
   if (activeTemplateKey === 'ncr') {
    body.innerHTML = renderNCRExact(report);
    updateProgress();
    const attachmentsHtml = renderAttachments(report?.attachments || []);
    body.innerHTML += attachmentsHtml;
    return;
 }
 if (activeTemplateKey === 'imir') {
    body.innerHTML = renderIMIRExact(report);
    updateProgress();
    const attachmentsHtml = renderAttachments(report?.attachments || []);
    body.innerHTML += attachmentsHtml;
    return;
 }
  // ★ ADD THIS:
else if (activeTemplateKey === 'audit') {
  console.log('🔍 [renderSheet] audit report meta.agency:', report?.meta?.agency);
  // Build the agency selection HTML with checkboxes only
  const agencyHtml = `
    <div style="margin-bottom: 12px; padding: 10px; background: #f0f4fa; border: 1px solid #dbe4ee; border-radius: 6px;">
      <label style="font-weight:700; display:block; margin-bottom: 4px;">Select Agency (Contractor) for this Audit:</label>
      <div class="exact-radio-line" style="display:flex; flex-wrap:wrap; gap:8px;">
        ${generateAgencyRadios(report?.meta?.agency || '')}
      </div>
    </div>
  `;
  body.innerHTML = agencyHtml + renderAuditExact(report);

  // --- No hidden input, no listeners – we read directly at save time ---

  updateProgress();
  const attachmentsHtml = renderAttachments(report?.attachments || []);
  body.innerHTML += attachmentsHtml;
  renderLinkedactivitys(report);
  populateactivityButtons();

  // Add Compliance Report button
  const existingComplianceBtn = document.getElementById('complianceBtnUnique');
  if (existingComplianceBtn) existingComplianceBtn.remove();
  const complianceBtn = document.createElement('button');
  complianceBtn.type = 'button';
  complianceBtn.className = 'btn btn-secondary';
  complianceBtn.innerHTML = '📋 Add Compliance Report';
  complianceBtn.id = 'complianceBtnUnique';
  complianceBtn.style.marginLeft = '8px';
  complianceBtn.addEventListener('click', function handler() {
    launchComplianceChecklist(report);
  });
  const buttonsContainer = document.getElementById('activityChecklistButtons');
  if (buttonsContainer) {
    buttonsContainer.parentNode.appendChild(complianceBtn);
  }
  return;
}
  else if (activeTemplateKey && activeTemplateKey.startsWith('activity_')) {
  body.innerHTML = renderactivityExact(report);
  updateProgress();
  const attachmentsHtml = renderAttachments(report?.attachments || []);
  body.innerHTML += attachmentsHtml;
  return;
} 
    // ← PASTE HERE ↓↓↓
  else if (activeTemplateKey === 'compliance_report') {
    body.innerHTML = renderComplianceExact(report);
    updateProgress();
    const attachmentsHtml = renderAttachments(report?.attachments || []);
    body.innerHTML += attachmentsHtml;
    return;
  }
  // ← PASTE HERE ↑↑↑
  let html = renderMetaRows(t.metaRows, meta);
  let si = 0;
  t.sections.forEach((sec) => {
    const secData = sectionsData[si] || {};
    if (sec.type === 'simple_check') html += renderSimpleCheck(sec, secData);
    else if (sec.type === 'checklist') html += renderChecklist(sec, secData);
    else if (sec.type === 'table') html += renderTable(sec, secData);
    else if (sec.type === 'accepted') html += renderAccepted(sec, secData);
    else if (sec.type === 'status') html += renderStatus(sec, secData, si);
    else if (sec.type === 'textarea') html += renderTextarea(sec, secData);
    else if (sec.type === 'signatures') html += renderSignatures(sec, secData);
    else if (sec.type === 'date') html += renderDate(sec, secData, sec.k);
    else if (sec.type === 'text') html += renderText(sec, secData);
    si++;
  });
  body.innerHTML = html;
  body.querySelectorAll('.status-select').forEach(stylizeStatus);
  const routingVal = meta.routing || 'Execution Engineer → QA Head';
  const radioGroup = document.querySelector('input[name="meta_routing"]');
  if (radioGroup) {
    const radios = document.querySelectorAll('input[name="meta_routing"]');
    radios.forEach(r => r.checked = (r.value === routingVal));
  }
  updateProgress();
  if (activeTemplateKey === 'rfi') {
    renderLinkedNCRs();
    renderLinkedChecklists();
  }
  const attachmentsHtml = renderAttachments(report?.attachments || []);
  body.innerHTML += attachmentsHtml;
}

// ============================================================
// 14. RENDER LINKED NCRs
// ============================================================
function renderLinkedNCRs() {
  const list = document.getElementById('relatedNCRList');
  if (!list) return;
  if (activeTemplateKey !== 'rfi') {
    list.innerHTML = '';
    return;
  }
  const rfiNo = document.getElementById('meta_rfiNo')?.value || '';
  const rfiId = activeReportId || '';
  let linked = [];
  if (rfiNo) linked = getLinkedNCRsForRfi(rfiNo);
  if (rfiId && rfiId !== rfiNo) {
    const extra = getLinkedNCRsForRfi(rfiId);
    linked = linked.concat(extra);
  }
  const seen = new Set();
  linked = linked.filter(n => {
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    return true;
  });
  if (!linked.length) {
    list.innerHTML = 'No linked NCR yet.';
    return;
  }
  let html = '<ul style="list-style:none;padding:0;margin:0;">';
  linked.forEach(n => {
    const status = n.status || 'Draft';
    const canEdit = canEditNCR(n);
    const editBtn = canEdit ? `<button class="btn btn-secondary" style="padding:4px 8px;font-size:11px;margin-left:6px;" onclick="openRecord('${n.id}')">Open & Edit</button>` : `<button class="btn btn-secondary" style="padding:4px 8px;font-size:11px;margin-left:6px;" onclick="openRecord('${n.id}')">View</button>`;
    html += `<li style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid #eee;">
      <span><b>${esc(n.meta?.ncrNo || n.id)}</b> – ${esc(status)}</span>
      ${editBtn}
    </li>`;
  });
  html += '</ul>';
  list.innerHTML = html;
}
function renderLinkedChecklists() {
  const list = document.getElementById('relatedChecklistList');
  if (!list) return;
  if (activeTemplateKey !== 'rfi') {
    list.innerHTML = '';
    return;
  }
  const rfiNo = document.getElementById('meta_rfiNo')?.value?.trim() || '';
  const rfiId = activeReportId || '';
  if (!rfiNo && !rfiId) {
    list.innerHTML = 'Please save the RFI first to link checklists.';
    return;
  }
  let linked = [];
  if (rfiNo) linked = getLinkedChecklistsForRfi(rfiNo);
  if (rfiId && rfiId !== rfiNo) {
    const extra = getLinkedChecklistsForRfi(rfiId);
    linked = linked.concat(extra);
  }
  // Deduplicate
  const seen = new Set();
  linked = linked.filter(chk => {
    if (seen.has(chk.id)) return false;
    seen.add(chk.id);
    return true;
  });
  if (!linked.length) {
    list.innerHTML = 'No linked checklist yet. Use the buttons above to add one.';
    return;
  }
  let html = `<table class="kpi-table" style="font-size:12px;margin-top:6px;">
    <thead><tr><th>Name</th><th>Status</th><th>Date</th><th>Action</th></tr></thead><tbody>`;
  linked.forEach(chk => {
    const dateStr = fmtDateTime(chk.savedAt || chk.meta?.date || '');
    html += `<tr>
      <td><b>${esc(chk.templateName)}</b></td>
      <td>${badgeForStatus(chk.status || 'Draft')}</td>
      <td class="small">${dateStr}</td>
      <td><button class="btn btn-secondary" style="padding:4px 8px;font-size:11px;" onclick="openRecord('${chk.id}')">Open</button></td>
    </tr>`;
  });
  html += '</tbody></table>';
  list.innerHTML = html;
}
  // ============================================================
// RENDER LINKED activity CHECKLISTS (for Audit Reports)
// ============================================================
function renderLinkedactivitys(auditReport) {
  const list = document.getElementById('relatedactivityList');
  if (!list) return;
  if (!auditReport) {
    list.innerHTML = 'No linked activity checklist yet.';
    return;
  }
  const auditNo = auditReport.meta?.reportNo || auditReport.id || '';
  const linked = savedReports.filter(r => 
    r.templateKey?.startsWith('activity_') && 
    (r.meta?.linkedAudit === auditNo || r.meta?.linkedAudit === auditReport.id)
  );
  if (!linked.length) {
    list.innerHTML = 'No linked activity checklist yet. Use the buttons above to add one.';
    return;
  }
  let html = `<table class="kpi-table" style="font-size:12px;margin-top:6px;">
    <thead><tr><th>Name</th><th>Status</th><th>Date</th><th>Action</th></tr></thead><tbody>`;
  linked.forEach(chk => {
    const dateStr = fmtDateTime(chk.savedAt || chk.meta?.date || '');
    html += `<tr>
      <td><b>${esc(chk.templateName)}</b></td>
      <td>${badgeForStatus(chk.status || 'Draft')}</td>
      <td class="small">${dateStr}</td>
      <td><button class="btn btn-secondary" style="padding:4px 8px;font-size:11px;" onclick="openRecord('${chk.id}')">Open</button></td>
    </tr>`;
  });
  html += '</tbody></table>';
  list.innerHTML = html;
}
  function renderAttachments(attachments) {
  if (!attachments || attachments.length === 0) return '';
  
  let html = `<div style="margin-top:16px; border-top:2px solid var(--line); padding-top:12px;">
    <div style="font-weight:700; font-size:14px; color:var(--blue); margin-bottom:8px;">📎 Attachments</div>
    <div style="display:flex; flex-wrap:wrap; gap:12px;">`;

  attachments.forEach(att => {
    // --- Safety: skip if data is missing ---
    if (!att.data) {
      html += `<div style="padding:8px 12px; background:#f0f4fa; border-radius:6px; border:1px solid var(--line);">
        <span style="color:#888;">⚠️ ${esc(att.name)} (data missing)</span>
      </div>`;
      return;
    }

    if (att.type && att.type.startsWith('image/')) {
      html += `<div style="max-width:200px; border:1px solid var(--line); border-radius:8px; overflow:hidden; padding:4px; background:#fff;">
        <img src="${att.data}" alt="${esc(att.name)}" style="width:100%; height:auto; display:block; object-fit:cover; max-height:150px;">
        <div style="font-size:11px; text-align:center; padding:4px 0; color:#555;">${esc(att.name)}</div>
      </div>`;
    } else {
      html += `<div style="padding:8px 12px; background:#f0f4fa; border-radius:6px; border:1px solid var(--line);">
        <a href="${att.data}" download="${esc(att.name)}" style="color:var(--blue); text-decoration:none;">
          📎 ${esc(att.name)}
        </a>
      </div>`;
    }
  });

  html += `</div></div>`;
  return html;
}
 // ============================================================
// 15. DATA COLLECTION
function collectMeta(t) {
  const meta = {};
  
  // 1. Collect from metaRows (the top part of the form)
  t.metaRows.flat().forEach(cell => {
    if (cell.t === 'radio') {
      const checked = document.querySelector(`input[name="meta_${cell.k}"]:checked`);
      meta[cell.k] = checked ? checked.value : '';
    } else {
      const el = document.getElementById('meta_' + cell.k);
      if (el) meta[cell.k] = el.value || '';
    }
  });

  // ★ NEW: For NCR, read the agency from radio buttons
 if (activeTemplateKey === 'ncr') {
  const checkedAgencies = document.querySelectorAll('input[name="meta_agency"]:checked');
  const agencies = Array.from(checkedAgencies)
    .map(cb => cb.value)
    .filter(v => v && v.trim() !== '');
  meta.agency = agencies; // now an array
  console.log('🔍 [collectMeta] NCR agencies:', meta.agency);
}
  // 2. Collect any additional inputs inside #sheetBody with id="meta_*"
  document.querySelectorAll('#sheetBody [id^="meta_"]').forEach(el => {
    const key = el.id.replace(/^meta_/, '');
    // Don't override agency if we already got it from radio
    if (key === 'agency' && meta.agency) return;
    meta[key] = el.value || '';
  });

  if (!meta.routing) meta.routing = 'Execution Engineer → QA Head';
  return meta;
}

function collectSections(t) {
  // Early returns for special template types
  if (activeTemplateKey === 'ncr') return collectNCRSectionsExact();
  if (activeTemplateKey === 'imir') return collectIMIRSectionsExact();
  if (activeTemplateKey === 'audit') return collectAuditSectionsExact();
  if (activeTemplateKey && activeTemplateKey.startsWith('activity_')) {
    return collectactivitySectionsExact();
  }
  if (activeTemplateKey === 'compliance_report') {
  return collectComplianceSectionsExact();
}

  // For all other templates (rfi, brick, plaster, concrete, etc.)
  const shell = document.getElementById('sheetBody');
  if (!shell) return [];
  const sectionTables = Array.from(shell.children).slice(1);
  const sections = [];

  sectionTables.forEach((tbl, idx) => {
    const sec = t.sections[idx];
    if (!sec) return;

    if (sec.type === 'simple_check') {
      const rows = Array.from(tbl.querySelectorAll('tr')).slice(2);
      sections.push({
        type: 'simple_check',
        items: rows.map(r => ({
          contractor: r.cells[1]?.querySelector('input')?.value || '',
          company: r.cells[2]?.querySelector('input')?.value || '',
          remarks: r.cells[3]?.querySelector('input')?.value || '',
          status: r.cells[4]?.querySelector('select')?.value || ''
        }))
      });
    }
    else if (sec.type === 'checklist') {
      const items = [];
      Array.from(tbl.querySelectorAll('tr')).slice(1).forEach(r => {
        if (r.classList.contains('check-section-row')) return;
        items.push({
          status: r.cells[2]?.querySelector('select')?.value || '',
          remarks: r.cells[3]?.querySelector('textarea')?.value || ''
        });
      });
      sections.push({ type: 'checklist', items });
    }
    else if (sec.type === 'table') {
      const rows = Array.from(tbl.querySelectorAll('tr')).slice(2).map(r =>
        Array.from(r.querySelectorAll('input')).map(i => i.value)
      );
      sections.push({ type: 'table', rows });
    }
    else if (sec.type === 'accepted') {
      sections.push({
        type: 'accepted',
        rows: Array.from(tbl.querySelectorAll('tr')).slice(2).map(r => ({
          name: r.cells[1]?.querySelector('input')?.value || '',
          sign: r.cells[2]?.querySelector('input')?.value || '',
          date: r.cells[3]?.querySelector('input')?.value || ''
        }))
      });
    }
    else if (sec.type === 'status') {
      const checked = tbl.querySelector('input[type="radio"]:checked');
      sections.push({ type: 'status', value: checked ? checked.value : '' });
    }
    else if (sec.type === 'textarea') {
      sections.push({ type: 'textarea', value: tbl.querySelector('textarea')?.value || '' });
    }
    else if (sec.type === 'signatures') {
      const cells = tbl.querySelectorAll('tr')[1]?.cells || [];
      sections.push({
        type: 'signatures',
        entries: Array.from(cells).map((cell, ci) => ({
          role: sec.roles[ci] || '',
          name: cell.querySelectorAll('input')[0]?.value || '',
          sign: cell.querySelectorAll('input')[1]?.value || '',
          date: cell.querySelectorAll('input')[2]?.value || ''
        }))
      });
    }
    else if (sec.type === 'date') {
      const el = tbl.querySelector('input');
      sections.push({ type: 'date', [sec.k]: el ? el.value : '' });
    }
    else if (sec.type === 'text') {
      const el = tbl.querySelector('input');
      sections.push({ type: 'text', [sec.k]: el ? el.value : '' });
    }
  });

  return sections;
}
function collectSectionsForProgress() {
  let total = 0, filled = 0, yes = 0, no = 0;

  // For compliance report: count filled rows in the table
  if (activeTemplateKey === 'compliance_report') {
    const rows = document.querySelectorAll('.compliance-table tbody tr');
    let rowCount = rows.length;
    let filledRows = 0;
    rows.forEach(tr => {
      const inputs = tr.querySelectorAll('input, select, textarea');
      let hasData = false;
      inputs.forEach(inp => {
        if (inp.value && inp.value.trim() !== '') hasData = true;
      });
      if (hasData) filledRows++;
    });
    return {
      total: rowCount,
      filled: filledRows,
      score: rowCount ? Math.round((filledRows / rowCount) * 100) : 100
    };
  }

  // For other templates: count status selects
  document.querySelectorAll('#sheetBody .status-select').forEach(sel => {
    total++;
    if (sel.value) { filled++; if (sel.value === 'Yes') yes++; if (sel.value === 'No') no++; }
  });
  return { total, filled, score: (yes + no) ? Math.round((yes / (yes + no)) * 100) : 100 };
}
function updateProgress() {
  if (!activeTemplateKey) {
    document.getElementById('progressText').innerText = '0 / 0 Items | 0%';
    document.getElementById('progressBar').style.width = '0%';
    return;
  }
  const s = collectSectionsForProgress();
  document.getElementById('progressText').innerText = `${s.filled} / ${s.total} Items | ${s.score}%`;
  document.getElementById('progressBar').style.width = s.total ? `${(s.filled / s.total) * 100}%` : '0%';
}

// ============================================================
// 16. SAVE & WORKFLOW (with server sync)
// ============================================================
function validateForm(meta) {
  const req = [];
  if (activeTemplateKey === 'rfi') {
    if (!meta.project) req.push('Project');
    if (!meta.contractor) req.push('Contractor');
    if (!meta.date) req.push('Inspection Date');
    if (!meta.location) req.push('Inspection Location');
    if (!meta.raisedBy) req.push('Raised By');
    if (!meta.discipline) req.push('Discipline');
  } else if (activeTemplateKey === 'ncr') {
    if (!meta.project) req.push('Project');
    if (!meta.ncrNo) req.push('NCR No.');
    if (!meta.agency || (Array.isArray(meta.agency) && meta.agency.length === 0)) {
        req.push('At least one Agency');
    }
    if (!meta.ncrDate) req.push('NCR Date');
} else if (activeTemplateKey === 'imir') {
    if (!meta.client) req.push('Client');
    if (!meta.package) req.push('Package/System');
    if (!meta.date) req.push('Date');
  } 
   else if (activeTemplateKey === 'audit') {
    if (!meta.project) req.push('Project');
    if (!meta.reportNo) req.push('Report No.');
    if (!meta.auditor) req.push('Auditor');
    if (!meta.auditDate) req.push('Audit Date');
}
 else {
    if (!meta.project) req.push('Project');
    if (!meta.contractor) req.push('Contractor');
    if (!meta.date) req.push('Date');
  }
  if (req.length) { toast('❌ Required: ' + req.join(', ')); return false; }
  return true;
}
function getAuditNow(action, comment) {
  return { action, by: currentUser?.display || 'Unknown', role: currentUser?.role || '', at: new Date().toISOString(), comment: comment || '' };
}
function currentRecord() { return activeReportId ? savedReports.find(r => r.id === activeReportId) : null; }

// ===== canEditNCR – allows contractors to edit Submitted, Open, Rejected =====
// ===== canEditNCR – allows contractors and exec engineers to edit if assigned =====
function canEditNCR(rec) {
  if (!rec) {
    // New NCR: allow creation if user is QA/Exec/Manager/Admin
    return currentUser?.role === 'qa_head' || currentUser?.role === 'exec_engineer' || currentUser?.role === 'manager' || currentUser?.role === 'admin';
  }
  const status = rec.status || 'Draft';
  const user = currentUser;
  const isContractor = user?.role === 'engineer' || user?.role === 'exec_engineer';
  const isQAExec = user?.role === 'qa_head' || user?.role === 'exec_engineer' || user?.role === 'manager' || user?.role === 'admin';

  // Cannot edit if closed or approved
  if (status === 'Closed' || status === 'Approved') return false;

  // QA/Exec/Manager/Admin can edit Draft, Open, Rejected, Under Review
  if (isQAExec) {
    return status === 'Draft' || status === 'Open' || status === 'Rejected' || status === 'Under Review';
  }

  // Contractors (engineer/exec_engineer) can edit ONLY if they are the assigned agency
  if (isContractor) {
    const agency = rec.meta?.agency;
    if (Array.isArray(agency) && agency.includes(user.username)) {
      return status === 'Open' || status === 'Rejected';
    }
    if (typeof agency === 'string' && agency === user.username) {
      return status === 'Open' || status === 'Rejected';
    }
    return false;
  }

  return false;
}
// ★★★ PASTE HERE ★★★
// ===== canEditAudit – allows contractors/exec engineers to edit when status is Open or Rejected =====
// ===== canEditAudit – allows QA Head/Manager/Admin to edit any draft/open audit =====
function canEditAudit(rec) {
  if (!rec) {
    // New audit: allow creation if user is QA/Exec/Manager/Admin
    return currentUser?.role === 'qa_head' || currentUser?.role === 'exec_engineer' || currentUser?.role === 'manager' || currentUser?.role === 'admin';
  }
  const status = rec.status || 'Draft';
  // Cannot edit when closed, approved, or under review
  if (status === 'Closed' || status === 'Approved' || status === 'Under Review') return false;

  // --- ADD THIS BLOCK: QA Head, Manager, Admin can edit any draft/open/rejected audit ---
  if (currentUser?.role === 'qa_head' || currentUser?.role === 'manager' || currentUser?.role === 'admin') {
    // They can edit in Draft, Open, or Rejected
    if (status === 'Draft' || status === 'Open' || status === 'Rejected') {
      return true;
    }
  }

  // Creator (manager/QA/exec) can edit in Draft, Open, Rejected (they are the owner)
  if (rec.createdBy === currentUser?.username) return true;

  // For recipients (contractor/exec engineer): can edit only if they are in the selected agencies list
  // and the status is Open or Rejected
  if (rec.templateKey === 'audit' && (currentUser?.role === 'engineer' || currentUser?.role === 'exec_engineer')) {
    const agencies = rec.meta?.agency;
    if (Array.isArray(agencies) && agencies.includes(currentUser.username)) {
      return status === 'Open' || status === 'Rejected';
    }
  }
  return false;
}
function generateNcrNumber() {
  let counter = appConfig.ncrCounter || 1;
  const num = String(counter).padStart(3, '0');
  appConfig.ncrCounter = counter + 1;
  localStorage.setItem(CONFIG_KEY, JSON.stringify(appConfig));
  return 'NCR-' + num;
}
async function saveReport(ev) {
  ev.preventDefault();
  const t = templates[activeTemplateKey];
  if (!t) return;

  // 1. Collect standard meta fields
  const meta = collectMeta(t);

  // ★★★ CAPTURE AGENCIES FROM DOM (for audit only) ★★★
  if (activeTemplateKey === 'audit') {
    const checkedBoxes = document.querySelectorAll('input[name="meta_agency"]:checked');
    const agencies = Array.from(checkedBoxes)
      .map(cb => cb.value)
      .filter(v => v && v.trim() !== '');
    meta.agency = agencies;
    console.log('🔍 [saveReport] Agencies captured:', meta.agency);

    // ★★★ MANDATORY VALIDATION – blocks save if none selected ★★★
    if (meta.agency.length === 0) {
      toast('⚠️ Please select at least one Agency (Contractor/Execution Engineer) before saving.');
      return;
    }
  }

  // DEBUG: Log the collected meta
  console.log('🔍 [DEBUG] Collected meta:', meta);

  // --- NCR edit check ---
  if (activeTemplateKey === 'ncr') {
    const rec = currentRecord();
    if (!canEditNCR(rec)) {
      toast('⛔ You cannot edit this NCR in its current state');
      return;
    }
    if (!meta.ncrNo || meta.ncrNo.trim() === '') {
      meta.ncrNo = generateNcrNumber();
    }
  }

  // --- AUDIT edit check ---
  if (activeTemplateKey === 'audit') {
    const rec = currentRecord();
    if (!canEditAudit(rec)) {
      toast('⛔ You cannot edit this audit in its current state');
      return;
    }
  }

  // --- IMIR number generation ---
  if (activeTemplateKey === 'imir' && (!meta.imirNo || meta.imirNo.trim() === '')) {
    meta.imirNo = 'IMIR-' + String(appConfig.imirCounter || 1).padStart(3, '0');
    appConfig.imirCounter = (appConfig.imirCounter || 1) + 1;
    localStorage.setItem(CONFIG_KEY, JSON.stringify(appConfig));
  }

  // ★★★ DELETE THE OLD VALIDATION BLOCK – the one that filtered 'validAgencies' ★★★
  // (It used to be here – we've removed it entirely)

  // 3. Collect sections and build the row object
  const sections = collectSections(t);
  const existing = activeReportId ? savedReports.find(r => r.id === activeReportId) : null;
  const id = activeReportId || ('rep_' + Date.now());
  const titleLoc = meta.building || meta.structure || meta.location || meta.project || getProjectDisplay();
  const preparedBy = meta.preparedBy || meta.raisedBy || meta.contractor || meta.agency || meta.to || '';

  // --- Handle file attachments ---
  const attachmentInput = document.getElementById('wfAttachment');
  let attachmentData = [];

  if (attachmentInput && attachmentInput.files.length > 0) {
    const files = attachmentInput.files;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.size > 2 * 1024 * 1024) {
        toast('⚠️ File ' + file.name + ' exceeds 2MB limit – skipped.');
        continue;
      }
      let blobToEncode = file;
      if (file.type && file.type.startsWith('image/')) {
        try {
          blobToEncode = await compressImage(file, 800, 0.7);
        } catch (e) {
          console.warn('Compression failed, using original file', e);
          blobToEncode = file;
        }
      }
      const data = await readFileAsBase64(blobToEncode);
      attachmentData.push({
        name: file.name,
        type: file.type,
        data: data
      });
    }
  }

  const existingAttachments = existing?.attachments || [];
  const mergedAttachments = [...existingAttachments, ...attachmentData];
  const raisedFromRfi = meta.raisedFromRfi || existing?.raisedFromRfi || '';

  // --- Build the row object ---
  const row = {
    id: id,
    templateKey: activeTemplateKey,
    templateName: t.title,
    formatNo: t.formatNo || buildFormatNo('01'),
    meta: meta,
    sections: sections,
    score: 0,
    defectsCount: 0,
    titleLoc: titleLoc,
    preparedBy: preparedBy,
    status: existing?.status || 'Draft',
    comment: document.getElementById('wfComment')?.value.trim() || existing?.comment || '',
    attachments: mergedAttachments,
    createdBy: existing?.createdBy || currentUser?.username || '',
    createdByDisplay: existing?.createdByDisplay || currentUser?.display || '',
    decisionBy: existing?.decisionBy || '',
    decisionByDisplay: existing?.decisionByDisplay || '',
    savedAt: new Date().toISOString(),
    audit: (existing?.audit || []).concat([getAuditNow(existing ? 'Updated' : 'Created', document.getElementById('wfComment')?.value.trim() || '')]),
    raisedFromRfi: raisedFromRfi
  };

  // --- Score calculation ---
  let yes = 0, no = 0;
  sections.forEach(sec => {
    if (sec.type === 'checklist' || sec.type === 'simple_check') {
      (sec.items || []).forEach(i => { if (i.status === 'Yes') yes++; if (i.status === 'No') no++; });
    }
  });
  row.score = (yes + no) ? Math.round((yes / (yes + no)) * 100) : 100;
  row.defectsCount = no;

  // --- Validate linked RFI for checklists ---
  if (activeTemplateKey !== 'rfi' && activeTemplateKey !== 'ncr' && activeTemplateKey !== 'imir' && activeTemplateKey !== 'audit' && !activeTemplateKey.startsWith('activity_') && !row.meta.linkedRfi) {
    toast('⚠️ Please select Linked RFI No before saving checklist');
    return;
  }
// --- Save to server ---
try {
  const isNew = !savedReports.find(r => r.id === id);
  await syncReportToServer(row, isNew);
  activeReportId = id;

  // --- RFI specific logic ---
  if (activeTemplateKey === 'rfi') {
    pendingReturnRfiId = id;
    pendingLinkedRfiNo = row.meta?.rfiNo || pendingLinkedRfiNo;
    pendingParentMeta = { project: meta.project, package: meta.package, contractor: meta.contractor, projectCode: meta.projectCode, date: meta.date };
    renderLinkedNCRs();

    // --- After saving RFI, check if it was created from NCR ---
    const ncrDocData = sessionStorage.getItem('ncrPendingDoc');
    if (ncrDocData) {
      try {
        const data = JSON.parse(ncrDocData);
        if (data.action === 'create_rfi') {
          const ncr = savedReports.find(r => r.id === data.ncrId);
          if (ncr && ncr.templateKey === 'ncr') {
            const docs = ncr.meta?.supportingDocs || [];
            docs.push({
              type: 'rfi',
              rfiId: row.id,
              rfiNo: row.meta?.rfiNo || row.id,
              addedBy: currentUser.display || currentUser.username,
              addedAt: new Date().toISOString()
            });
            ncr.meta.supportingDocs = docs;
            await syncReportToServer(ncr, false);
            const idx = savedReports.findIndex(r => r.id === ncr.id);
            if (idx >= 0) savedReports[idx] = ncr;
            localStorage.setItem(STORAGE_KEY, JSON.stringify(savedReports));
            toast('✅ RFI linked to NCR');
          }
        }
        sessionStorage.removeItem('ncrPendingDoc');
      } catch (e) { console.warn('Error linking RFI to NCR:', e); }
    }
  }

  // --- NEW: After saving NCR, check if it was created from an Audit ---
  if (activeTemplateKey === 'ncr') {
    const auditLinkData = sessionStorage.getItem('auditNcrLinkContext');
    if (auditLinkData) {
      try {
        const data = JSON.parse(auditLinkData);
        const audit = savedReports.find(r => r.id === data.auditId);
        if (audit && audit.templateKey === 'audit') {
          const sections = audit.sections || [];
          const auditTable = sections[0] || { rows: [] };
          const rows = auditTable.rows || [];
          const rowIndex = data.rowIndex;
          const rowData = rows[rowIndex] || {};
          const linkedNCRs = rowData.linkedNCRs || [];
          linkedNCRs.push({
            ncrNo: row.meta?.ncrNo || row.id,
            ncrId: row.id,
            rowIndex: rowIndex
          });
          rowData.linkedNCRs = linkedNCRs;
          rows[rowIndex] = rowData;
          auditTable.rows = rows;
          sections[0] = auditTable;
          audit.sections = sections;
          await syncReportToServer(audit, false);
          const idx = savedReports.findIndex(r => r.id === audit.id);
          if (idx >= 0) savedReports[idx] = audit;
          localStorage.setItem(STORAGE_KEY, JSON.stringify(savedReports));
          toast('✅ NCR linked to audit row');
        }
        sessionStorage.removeItem('auditNcrLinkContext');
      } catch (e) { console.warn('Error linking NCR to audit:', e); }
    }
  }
    // --- After saving NCR, check if it was created from an Audit ---
  if (activeTemplateKey === 'ncr') {
    const auditLinkData = sessionStorage.getItem('auditNcrLinkContext');
    if (auditLinkData) {
      try {
        const data = JSON.parse(auditLinkData);
        const audit = savedReports.find(r => r.id === data.auditId);
        if (audit && audit.templateKey === 'audit') {
          const sections = audit.sections || [];
          const auditTable = sections[0] || { rows: [] };
          const rows = auditTable.rows || [];
          const rowIndex = data.rowIndex;
          const rowData = rows[rowIndex] || {};
          const linkedNCRs = rowData.linkedNCRs || [];
          linkedNCRs.push({
            ncrNo: row.meta?.ncrNo || row.id,
            ncrId: row.id,
            rowIndex: rowIndex
          });
          rowData.linkedNCRs = linkedNCRs;
          rows[rowIndex] = rowData;
          auditTable.rows = rows;
          sections[0] = auditTable;
          audit.sections = sections;
          await syncReportToServer(audit, false);
          const idx = savedReports.findIndex(r => r.id === audit.id);
          if (idx >= 0) savedReports[idx] = audit;
          localStorage.setItem(STORAGE_KEY, JSON.stringify(savedReports));
          toast('✅ NCR linked to audit row');
        }
        sessionStorage.removeItem('auditNcrLinkContext');
      } catch (e) { console.warn('Error linking NCR to audit:', e); }
    }
  }
  // --- Workflow & UI updates ---
  updateWorkflowButtons(row);
  setChecklistButtonsState(activeTemplateKey === 'rfi' ? row : null);
  toast('✅ Saved successfully');

  // Force refresh from server to get the latest data
  await loadFromServer();
  const refreshedRow = savedReports.find(r => r.id === row.id);
  if (refreshedRow) {
    renderSheet(t, refreshedRow);
  } else {
    renderSheet(t, row);
  }
  updateStats();
  renderHistory();
  updateNotificationUI();
} catch(e) {
  toast('❌ Save failed: ' + e.message);
}

async function deleteReport(id) {
  const r = savedReports.find(x => x.id === id);
  if (!r) return;
  if (!canDeleteRecord(r)) { toast('⛔ Delete not allowed'); return; }
  if (!confirm('Delete this saved report?')) return;
  try {
    await apiRequest(`/api/reports/${id}`, { method: 'DELETE' });
    toast('🗑️ Deleted');
    if (activeReportId === id) backFromForm();
    updateStats();
    renderHistory();
    updateNotificationUI();
  } catch(e) {
    toast('❌ Delete failed: ' + e.message);
  }
}

async function updateReportOnServer(row) {
  await syncReportToServer(row, false);
  // Update only the local UI – no full server reload
updateStats();
renderHistory();
updateNotificationUI();
toast('✅ Saved successfully');   // toast already exists, you can keep it
}

function updateWorkflowButtons(rec) {
  const isNcrFlag = isNcr();
  const isRfiFlag = isRfi();
  const isImirFlag = isImir();
  const panel = document.getElementById('workflowPanel');
  const relatedPanel = document.getElementById('relatedChecklistPanel');
  if (panel) panel.style.display = (isRfiFlag || isNcrFlag || isImirFlag || isAudit()) ? 'block' : 'none';
  if (relatedPanel) relatedPanel.style.display = isRfiFlag ? 'block' : 'none';
 if (!isRfiFlag && !isNcrFlag && !isImirFlag && !isAudit()) return;

  const status = rec?.status || 'Draft';
  const meta = rec?.meta || {};

  document.getElementById('wfStatus').value = status;
  document.getElementById('wfOwner').value = rec?.createdByDisplay || currentUser?.display || '';
  document.getElementById('wfDecisionBy').value = rec?.decisionByDisplay || '';

  const isExec = isExecEngineer();
  const isAdmin = currentUser?.role === 'admin';
  const isQA = canApprove();
  const isContractor = currentUser?.role === 'engineer';
  const isQAExec = isQA || isExec;

  if (isNcrFlag) {
    const editable = canEditNCR(rec);
    const showContractorSubmit = isContractor && editable && (status === 'Open' || status === 'Rejected');
    const showQASend = isQAExec && (status === 'Draft');
    const showApprove = isQAExec && (status === 'Under Review');
    const showReject = isQAExec && (status === 'Under Review');
    const showClose = isQAExec && (status === 'Approved' || status === 'Approved with Comment');

    document.getElementById('btnSubmit').classList.toggle('hidden', !showQASend);
    document.getElementById('btnReview').classList.toggle('hidden', !showContractorSubmit);
    document.getElementById('btnApprove').classList.toggle('hidden', !showApprove);
    document.getElementById('btnReject').classList.toggle('hidden', !showReject);
    document.getElementById('btnClose').classList.toggle('hidden', !showClose);
    document.getElementById('btnApproveComment').classList.toggle('hidden', true);
    document.getElementById('btnApproveQA').classList.toggle('hidden', true);
    document.getElementById('btnRaiseNCR').classList.toggle('hidden', true);
        // Show "Add Supporting Documents" button when NCR is not Closed
    const showAddDocs = rec?.status !== 'Closed' && 
      (currentUser?.role === 'engineer' || 
       currentUser?.role === 'exec_engineer' || 
       currentUser?.role === 'qa_head' || 
       currentUser?.role === 'manager' || 
       currentUser?.role === 'admin');
    
    document.getElementById('btnAddDocs').classList.toggle('hidden', !showAddDocs);
    return;
  }
   // ★★★★★ PASTE THE AUDIT BLOCK HERE ★★★★★
  // === AUDIT WORKFLOW ===
  else if (isAudit()) {
    const status = rec?.status || 'Draft';
    const isAllowedSubmitter = currentUser && (currentUser.role === 'qa_head' || currentUser.role === 'exec_engineer' || currentUser.role === 'manager' || currentUser.role === 'admin');
    const isContractor = currentUser?.role === 'engineer';
    
    const showSubmit = isAllowedSubmitter && (status === 'Draft');
    const showContractorSubmit = isContractor && (status === 'Open' || status === 'Rejected');
    const showApprove = isAllowedSubmitter && (status === 'Under Review');
    const showReject = isAllowedSubmitter && (status === 'Under Review');
    const showClose = isAllowedSubmitter && (status === 'Under Review');

    document.getElementById('btnSubmit').classList.toggle('hidden', !showSubmit);
    document.getElementById('btnReview').classList.toggle('hidden', !showContractorSubmit);
    document.getElementById('btnApprove').classList.toggle('hidden', !showApprove);
    document.getElementById('btnReject').classList.toggle('hidden', !showReject);
    document.getElementById('btnClose').classList.toggle('hidden', !showClose);
    
    document.getElementById('btnApproveComment').classList.toggle('hidden', true);
    document.getElementById('btnApproveQA').classList.toggle('hidden', true);
    document.getElementById('btnRaiseNCR').classList.toggle('hidden', true);
    return;
  }

  // <<< PASTE IMIR BLOCK HERE >>>
  // === IMIR WORKFLOW ===
  else if (isImirFlag) {
    const status = rec?.status || 'Draft';
    const isSubmitter = currentUser && (currentUser.role === 'engineer' || currentUser.role === 'admin');
    const isApprover = currentUser && (currentUser.role === 'qa_head' || currentUser.role === 'exec_engineer' || currentUser.role === 'manager' || currentUser.role === 'admin');

    const showSubmit = isSubmitter && (status === 'Draft');
    const showApprove = isApprover && (status === 'Submitted');
    const showReject = isApprover && (status === 'Submitted');

    document.getElementById('btnSubmit').classList.toggle('hidden', !showSubmit);
    document.getElementById('btnReview').classList.toggle('hidden', true);
    document.getElementById('btnApprove').classList.toggle('hidden', !showApprove);
    document.getElementById('btnReject').classList.toggle('hidden', !showReject);
    document.getElementById('btnClose').classList.toggle('hidden', true);
    document.getElementById('btnApproveComment').classList.toggle('hidden', true);
    document.getElementById('btnApproveQA').classList.toggle('hidden', true);
    document.getElementById('btnRaiseNCR').classList.toggle('hidden', true);
    return;
  }
  // ===== RFI WORKFLOW (comes after) =====
  const routing = meta.routing || 'Execution Engineer → QA Head';
  const isDirect = routing === 'Direct to QA Head';
  const isBoth = routing === 'Both';

  const showSubmit = currentUser && (currentUser.role === 'engineer' || isAdmin) && (!rec || ['Draft', 'Rejected'].includes(status));
  const showReview = isQA && status === 'Submitted';
  const showApproveQA = isExec && status === 'Submitted' && !isDirect;
  const showApprove = (isQA && (
    (isDirect && status === 'Submitted') ||
    (isBoth && (status === 'Submitted' || status === 'Approved by Execution')) ||
    (!isDirect && !isBoth && status === 'Approved by Execution')
  )) || (isExec && !isDirect && status === 'Submitted' && !isBoth);
  const showReject = (isQA && (
    (isDirect && status === 'Submitted') ||
    (isBoth && (status === 'Submitted' || status === 'Approved by Execution')) ||
    (!isDirect && !isBoth && status === 'Approved by Execution')
  )) || (isExec && (status === 'Submitted' || (isBoth && status === 'Approved by Execution')));
  const showClose = false;

  const btnRaiseNCR = document.getElementById('btnRaiseNCR');
  if (btnRaiseNCR) {
    btnRaiseNCR.classList.toggle('hidden', !(isRfiFlag && (isQA || isAdmin || isExec)));
  }

  document.getElementById('btnSubmit').classList.toggle('hidden', !showSubmit);
  document.getElementById('btnReview').classList.toggle('hidden', !showReview);
  document.getElementById('btnApproveQA').classList.toggle('hidden', !showApproveQA);
  document.getElementById('btnApprove').classList.toggle('hidden', !showApprove);
  document.getElementById('btnApproveComment').classList.toggle('hidden', !(showApprove && isRfiFlag));
  document.getElementById('btnReject').classList.toggle('hidden', !showReject);
  document.getElementById('btnClose').classList.toggle('hidden', showClose);
}

function setChecklistButtonsState(rec) {
  const isRfiFlag = isRfi();
  const disabled = !isRfiFlag || !canAddChecklistToRfi(rec);
  ['btnAddBrickChecklist', 'btnAddPlasterChecklist', 'btnAddConcreteChecklist'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = disabled;
  });
}

// ============================================================
// 17. WORKFLOW ACTIONS (with server sync)
// ============================================================
async function approveForQA() {
  const rec = currentRecord();
  if (!rec) { toast('⚠️ Open record first'); return; }
  if (!isExecEngineer()) { toast('⛔ Only Execution Engineer can perform this action'); return; }
  if (rec.status !== 'Submitted') { toast('⚠️ Only Submitted RFIs can be approved for QA'); return; }
  rec.status = 'Approved by Execution';
  rec.comment = document.getElementById('wfComment').value.trim() || 'Approved for QA by Execution Engineer';
  rec.decisionBy = currentUser.username;
  rec.decisionByDisplay = currentUser.display;
  rec.audit.push(getAuditNow('Approved for QA', rec.comment));
  rec.savedAt = new Date().toISOString();
  await updateReportOnServer(rec);
  updateWorkflowButtons(rec);
  toast('📋 RFI approved for QA review');
  
  const docNo = rec.meta?.rfiNo || rec.id || 'Unknown';
  // --- REPLACE allUsersCache with getUsersByRole ---
  const qaHeads = await getUsersByRole('qa_head');
  for (const qa of qaHeads) {
    await sendNotification(qa.username, `RFI #${docNo} approved for QA by ${currentUser.display}`, 'approved_for_qa', rec.id, docNo, currentUser.display);
  }
}

async function raiseNCRFromRFI() {
  const rfi = currentRecord();
  if (!rfi) { toast('⚠️ No RFI found.'); return; }
  if (!currentUser || (currentUser.role !== 'qa_head' && currentUser.role !== 'admin' && currentUser.role !== 'exec_engineer')) {
    toast('⛔ Only QA Head, Execution Engineer or Admin can raise NCR.');
    return;
  }
  const rfiMeta = rfi.meta || {};
  const ncrMeta = {
    ncrNo: generateNcrNumber(),
    category: '',
    project: rfiMeta.project || '',
    entityType: '',
    package: rfiMeta.package || '',
    agency: rfiMeta.contractor || '',
    wbsCode: '',
    location: rfiMeta.location || '',
    poSoName: '',
    discipline: rfiMeta.discipline || '',
    poSoNo: '',
    ncrDate: new Date().toISOString().split('T')[0],
    poSoDate: '',
    materialService: '',
    raisedFromRfi: rfiMeta.rfiNo || rfi.id || '',
    severity: '',
    responsible: ''
  };
  const ncrId = 'rep_' + Date.now();
  const newNCR = {
    id: ncrId,
    templateKey: 'ncr',
    templateName: 'NON CONFORMANCE REPORT',
    formatNo: 'ADANI/Q/F-09 Rev 0',
    meta: ncrMeta,
    sections: [],
    score: 0,
    defectsCount: 0,
    titleLoc: rfiMeta.project || '',
    preparedBy: currentUser.display || '',
    status: 'Draft',
    comment: '',
    attachments: [],
    createdBy: currentUser.username,
    createdByDisplay: currentUser.display,
    decisionBy: '',
    decisionByDisplay: '',
    savedAt: new Date().toISOString(),
    audit: [getAuditNow('Created from RFI #' + (rfiMeta.rfiNo || rfi.id || ''), '')],
    raisedFromRfi: rfiMeta.rfiNo || rfi.id || ''
  };
const docNo = rfiMeta.rfiNo || rfi.id || 'Unknown';
try {
  await syncReportToServer(newNCR, true);
  toast('📋 NCR created from RFI #' + docNo);
  if (rfi.createdBy) {
    await sendNotification(rfi.createdBy, `📋 NCR #${ncrMeta.ncrNo} raised from your RFI #${docNo} by ${currentUser.display}`, 'new_ncr', ncrId, docNo, currentUser.display);
  }
  openTemplate('ncr', ncrId);
} catch(e) {
  toast('❌ Failed to create NCR: ' + e.message);
}
}
async function submitRecord() {
  const rec = currentRecord();
  if (!rec) { toast('⚠️ Save first'); return; }

    // === NCR SUBMIT ===
  if (isNcr()) {
    if (rec.status !== 'Draft') { toast('⚠️ NCR is not in Draft state'); return; }
        // --- Collect current form data before submission ---
    const t = templates[activeTemplateKey];
    if (t) {
      const collectedMeta = collectMeta(t);
      // Merge collected meta into the record, preserving any existing fields
      rec.meta = { ...rec.meta, ...collectedMeta };
      console.log('🔍 [submitRecord] Collected NCR meta:', rec.meta);
    }
    rec.status = 'Open';
    rec.comment = document.getElementById('wfComment').value.trim() || 'NCR raised and sent to contractor';
    rec.savedAt = new Date().toISOString();
    rec.audit.push(getAuditNow('Sent to Contractor', rec.comment));
    await updateReportOnServer(rec);
    updateWorkflowButtons(rec);
    toast('📤 NCR sent to contractor');

    // --- FIX: define parentRfi ---
    const linkedRfiId = rec.raisedFromRfi || rec.meta?.raisedFromRfi || '';
    const parentRfi = linkedRfiId ? savedReports.find(r => r.templateKey === 'rfi' && (r.id === linkedRfiId || r.meta?.rfiNo === linkedRfiId)) : null;

    const agencyUsernames = Array.isArray(rec.meta?.agency) ? rec.meta.agency : (rec.meta?.agency ? [rec.meta.agency] : []);
    for (const username of agencyUsernames) {
      if (username) {
        await sendNotification(
          username,
          `📋 NCR #${rec.meta?.ncrNo || rec.id} is assigned to you. Please review and respond.`,
          'ncr_open',
          rec.id,
          rec.meta?.ncrNo || rec.id,
          currentUser.display
        );
      }
    }
    // Notify the RFI creator only if they are not already in the agency list
    if (parentRfi && parentRfi.createdBy && !agencyUsernames.includes(parentRfi.createdBy)) {
      await sendNotification(
        parentRfi.createdBy,
        `NCR #${rec.meta?.ncrNo || rec.id} is assigned to you. Please review and respond.`,
        'ncr_open',
        rec.id,
        rec.meta?.ncrNo || rec.id,
        currentUser.display
      );
    }
    return;
  }
  // === AUDIT SUBMIT ===
else if (isAudit()) {
  if (rec.status !== 'Draft') { toast('⚠️ Audit is not in Draft state'); return; }
  if (!rec.meta?.agency || rec.meta.agency.length === 0) {
    toast('⚠️ Please select at least one Agency before submitting');
    return;
  }
  
  rec.status = 'Open';
  rec.comment = document.getElementById('wfComment').value.trim() || 'Audit sent to contractor';
  rec.savedAt = new Date().toISOString();
  rec.audit.push(getAuditNow('Sent to Contractor', rec.comment));
  await updateReportOnServer(rec);
  updateWorkflowButtons(rec);
  toast('📤 Audit sent to selected agencies');

   // Notify each selected user (contractor and/or exec engineer)
  for (const username of rec.meta.agency) {
    // ✅ Directly pass the username - no lookup needed
    await sendNotification(
      username,  // <-- CHANGED HERE
      `📋 Audit #${rec.meta?.reportNo || rec.id} is assigned to you. Please review and respond.`,
      'ncr_open',
      rec.id,
      rec.meta?.reportNo || rec.id,
      currentUser.display
    );
  }
  return;
}
   // === IMIR SUBMIT ===  (MOVED OUTSIDE NCR BLOCK)
  else if (isImir()) {
    if (rec.status !== 'Draft') { toast('⚠️ IMIR is not in Draft state'); return; }
    rec.status = 'Submitted';
    rec.comment = document.getElementById('wfComment').value.trim() || 'Material submitted for approval';
    rec.savedAt = new Date().toISOString();
    rec.audit.push(getAuditNow('Submitted for Approval', rec.comment));
    await updateReportOnServer(rec);
    updateWorkflowButtons(rec);
    toast('📤 IMIR submitted for approval');
    
    // --- REPLACE allUsersCache with getUsersByRole ---
    const roles = ['qa_head', 'exec_engineer', 'manager', 'admin'];
    for (const role of roles) {
      const users = await getUsersByRole(role);
      for (const user of users) {
        await sendNotification(user.username, `📋 IMIR #${rec.meta?.imirNo || rec.id} submitted for approval`, 'ncr_submitted', rec.id, rec.meta?.imirNo || rec.id, currentUser.display);
      }
    }
    return;
  }

  // === RFI SUBMIT ===
  if (rec.status === 'Submitted') { toast('⚠️ Already submitted'); return; }

  // Set status locally only after we confirm server save
  const newStatus = 'Submitted';
  const newComment = document.getElementById('wfComment').value.trim();

  try {
    // Update the record object
    rec.status = newStatus;
    rec.comment = newComment;
    rec.audit.push(getAuditNow('Submitted', rec.comment));
    rec.savedAt = new Date().toISOString();

    // Save to server – wait for confirmation
    await updateReportOnServer(rec);
    console.log('✅ RFI successfully saved as Submitted');

    // Reload the record from server to ensure we have the latest data
    const fresh = savedReports.find(r => r.id === rec.id);
    if (fresh) Object.assign(rec, fresh);

  } catch (saveError) {
    console.error('❌ Failed to submit RFI:', saveError);
    toast('❌ Submission failed. Please try again.');
    // Revert local status to Draft to keep consistency
    rec.status = 'Draft';
    return;
  }

  // --- Send notifications (only if save succeeded) ---
  const routing = rec.meta.routing || 'Execution Engineer → QA Head';
  const docNo = rec.meta?.rfiNo || rec.id || 'Unknown';

  if (routing === 'Direct to QA Head') {
    const qaHeads = await getUsersByRole('qa_head');
    for (const qa of qaHeads) {
      await sendNotification(qa.username, `New RFI #${docNo} submitted directly to QA Head by ${currentUser.display}`, 'new_rfi', rec.id, docNo, currentUser.display);
    }
  } else if (routing === 'Execution Engineer → QA Head') {
    const execs = await getUsersByRole('exec_engineer');
    for (const exec of execs) {
      await sendNotification(exec.username, `New RFI #${docNo} submitted by ${currentUser.display} – awaiting your review`, 'new_rfi', rec.id, docNo, currentUser.display);
    }
  } else if (routing === 'Both') {
    const execs = await getUsersByRole('exec_engineer');
    const qaHeads = await getUsersByRole('qa_head');
    for (const exec of execs) {
      await sendNotification(exec.username, `New RFI #${docNo} submitted by ${currentUser.display} – you can review or approve for QA`, 'new_rfi', rec.id, docNo, currentUser.display);
    }
    for (const qa of qaHeads) {
      await sendNotification(qa.username, `New RFI #${docNo} submitted by ${currentUser.display} – you can approve directly or wait for Execution Engineer`, 'new_rfi', rec.id, docNo, currentUser.display);
    }
  }

  updateWorkflowButtons(rec);
  setChecklistButtonsState(rec);
  toast('📤 Submitted');
}
async function markUnderReview() {
  const rec = currentRecord();
  if (!rec) { toast('⚠️ Open record first'); return; }
  // === NCR ===
 if (isNcr()) {
  // ★★★ Allow BOTH engineer AND exec_engineer to submit ★★★
  if (currentUser?.role !== 'engineer' && currentUser?.role !== 'exec_engineer') {
    toast('⛔ Only contractor or execution engineer can submit NCR response');
    return;
  }
    if (rec.status !== 'Open' && rec.status !== 'Rejected') {
      toast('⚠️ Cannot submit this NCR');
      return;
    }
    rec.status = 'Under Review';
    rec.comment = document.getElementById('wfComment').value.trim() || 'Contractor submitted response for review';
    rec.savedAt = new Date().toISOString();
    rec.audit.push(getAuditNow('Submitted by Contractor', rec.comment));
    await updateReportOnServer(rec);
    updateWorkflowButtons(rec);
    toast('📩 Response submitted for review');
    
    // --- REPLACE allUsersCache with getUsersByRole ---
    const docNo = rec.meta?.ncrNo || rec.id || 'Unknown';
    const qaHeads = await getUsersByRole('qa_head');
    const execUsers = await getUsersByRole('exec_engineer');
    for (const qa of qaHeads) {
      await sendNotification(qa.username, `NCR #${docNo} response submitted by Contractor for review`, 'ncr_submitted', rec.id, docNo, currentUser.display);
    }
    for (const exec of execUsers) {
      await sendNotification(exec.username, `NCR #${docNo} response submitted by Contractor for review`, 'ncr_submitted', rec.id, docNo, currentUser.display);
    }
    return;
  }
  // === AUDIT CONTRACTOR RESPONSE ===
  else if (isAudit()) {
    if (currentUser?.role !== 'engineer') {
      toast('⛔ Only contractor can submit audit response');
      return;
    }
    if (rec.status !== 'Open' && rec.status !== 'Rejected') {
      toast('⚠️ Cannot submit this audit');
      return;
    }
    rec.status = 'Under Review';
    rec.comment = document.getElementById('wfComment').value.trim() || 'Contractor submitted response for review';
    rec.savedAt = new Date().toISOString();
    rec.audit.push(getAuditNow('Submitted by Contractor', rec.comment));
    await updateReportOnServer(rec);
    updateWorkflowButtons(rec);
    toast('📩 Audit response submitted for review');
    
    // --- REPLACE allUsersCache with getUsersByRole ---
    const docNo = rec.meta?.reportNo || rec.id || 'Unknown';
    const roles = ['qa_head', 'exec_engineer', 'manager', 'admin'];
    for (const role of roles) {
      const users = await getUsersByRole(role);
      for (const user of users) {
        await sendNotification(user.username, `📋 Audit #${docNo} response submitted by Contractor for review`, 'ncr_submitted', rec.id, docNo, currentUser.display);
      }
    }
    return;
  }


  // === RFI ===
  rec.status = 'Under Review';
  rec.comment = document.getElementById('wfComment').value.trim();
  rec.audit.push(getAuditNow('Marked Under Review', rec.comment));
  rec.savedAt = new Date().toISOString();
  await updateReportOnServer(rec);
  updateWorkflowButtons(rec);
  toast('🔍 Under review');
  if (rec.createdBy) {
    const docNo = rec.meta?.rfiNo || rec.id || 'Unknown';
    await sendNotification(rec.createdBy, `Your RFI #${docNo} is now Under Review by ${currentUser.display}`, 'under_review', rec.id, docNo, currentUser.display);
  }
}

async function approveRecord() {
  const rec = currentRecord();
  if (!rec) { toast('⚠️ Open record first'); return; }

  // === NCR ===
  if (isNcr()) {
    if (!(canApprove() || isExecEngineer())) { toast('⛔ Only QA/Exec can approve NCR'); return; }
    if (rec.status !== 'Under Review') { toast('⚠️ Cannot approve now'); return; }
    rec.status = 'Closed';
    rec.comment = document.getElementById('wfComment').value.trim() || 'NCR Approved and Closed';
    rec.decisionBy = currentUser.username;
    rec.decisionByDisplay = currentUser.display;
    rec.savedAt = new Date().toISOString();
    rec.audit.push(getAuditNow('Approved & Closed', rec.comment));
    await updateReportOnServer(rec);
    updateWorkflowButtons(rec);
    toast('✅ NCR Closed');
    const linkedRfiId = rec.raisedFromRfi || rec.meta?.raisedFromRfi || '';
const parentRfi = linkedRfiId ? savedReports.find(r => r.templateKey === 'rfi' && (r.id === linkedRfiId || r.meta?.rfiNo === linkedRfiId)) : null;
   if (parentRfi && parentRfi.createdBy) {
  await sendNotification(
    parentRfi.createdBy,
    `NCR #${rec.meta?.ncrNo || rec.id} has been Approved & Closed by ${currentUser.display}`,
    'closed_ncr',
    rec.id,
    rec.meta?.ncrNo || rec.id,
    currentUser.display
  );
}
    // Also notify the assigned agency/agencies
const agencyUsernames = Array.isArray(rec.meta?.agency) ? rec.meta.agency : (rec.meta?.agency ? [rec.meta.agency] : []);
for (const username of agencyUsernames) {
  if (username && username !== parentRfi?.createdBy) { // avoid duplicate if same person
    await sendNotification(
      username,
      `✅ NCR #${rec.meta?.ncrNo || rec.id} has been Approved & Closed by ${currentUser.display}`,
      'closed_ncr',
      rec.id,
      rec.meta?.ncrNo || rec.id,
      currentUser.display
    );
  }
}
    return;
  }

 // === AUDIT APPROVE ===
else if (isAudit()) {
  if (!(canApprove() || isExecEngineer() || currentUser?.role === 'manager')) {
    toast('⛔ Only QA/Exec/Manager can approve audit');
    return;
  }
  if (rec.status !== 'Under Review') { toast('⚠️ Cannot approve now'); return; }
  rec.status = 'Closed';
  rec.comment = document.getElementById('wfComment').value.trim() || 'Audit Approved and Closed';
  rec.decisionBy = currentUser.username;
  rec.decisionByDisplay = currentUser.display;
  rec.savedAt = new Date().toISOString();
  rec.audit.push(getAuditNow('Approved & Closed', rec.comment));
  await updateReportOnServer(rec);
  updateWorkflowButtons(rec);
  toast('✅ Audit Closed');

  // Notify each selected agency
if (rec.meta?.agency && Array.isArray(rec.meta.agency)) {
  for (const username of rec.meta.agency) {
    await sendNotification(
      username,
      `✅ Audit #${rec.meta?.reportNo || rec.id} has been Approved & Closed by ${currentUser.display}`,
      'closed_ncr',
      rec.id,
      rec.meta?.reportNo || rec.id,
      currentUser.display
    );
  }
}
  return;
}
  // === IMIR APPROVE ===
else if (isImir()) {
  if (!(canApprove() || isExecEngineer() || currentUser?.role === 'manager')) {
    toast('⛔ Only QA/Exec/Manager can approve IMIR');
    return;
  }
  if (rec.status !== 'Submitted') { toast('⚠️ Cannot approve now'); return; }
  rec.status = 'Approved';
  rec.comment = document.getElementById('wfComment').value.trim() || 'Material Approved';
  rec.decisionBy = currentUser.username;
  rec.decisionByDisplay = currentUser.display;
  rec.savedAt = new Date().toISOString();
  rec.audit.push(getAuditNow('Approved', rec.comment));
  await updateReportOnServer(rec);
  updateWorkflowButtons(rec);
  toast('✅ IMIR Approved');
  if (rec.createdBy) {
    await sendNotification(rec.createdBy, `✅ IMIR #${rec.meta?.imirNo || rec.id} Approved by ${currentUser.display}`, 'approved', rec.id, rec.meta?.imirNo || rec.id, currentUser.display);
  }
  return;
}
  // === RFI ===
  rec.status = 'Approved';
  rec.comment = document.getElementById('wfComment').value.trim();
  rec.decisionBy = currentUser.username;
  rec.decisionByDisplay = currentUser.display;
  rec.audit.push(getAuditNow('Approved', rec.comment));
  rec.savedAt = new Date().toISOString();
  await updateReportOnServer(rec);
  updateWorkflowButtons(rec);
  toast('✅ Approved');
  if (rec.createdBy) {
    const docNo = rec.meta?.rfiNo || rec.id || 'Unknown';
    await sendNotification(rec.createdBy, `Your ${rec.templateKey === 'imir' ? 'IMIR' : 'RFI'} #${docNo} has been Approved by ${currentUser.display}`, 'approved', rec.id, docNo, currentUser.display);
  }
}

async function approveWithCommentRecord() {
  const rec = currentRecord();
  if (!rec) { toast('⚠️ Open record first'); return; }
  const c = document.getElementById('wfComment').value.trim();
  if (!c) { toast('⚠️ Enter approval comment'); return; }
  rec.status = 'Approved with Comment';
  rec.comment = c;
  rec.decisionBy = currentUser.username;
  rec.decisionByDisplay = currentUser.display;
  rec.audit.push(getAuditNow('Approved with Comment', c));
  rec.savedAt = new Date().toISOString();
  await updateReportOnServer(rec);
  updateWorkflowButtons(rec);
  toast('📝 Approved with comment');
  if (rec.createdBy) {
    const docNo = rec.meta?.rfiNo || rec.id || 'Unknown';
    await sendNotification(rec.createdBy, `Your RFI #${docNo} has been Approved with Comment by ${currentUser.display}`, 'approved_comment', rec.id, docNo, currentUser.display);
  }
}

async function rejectRecord() {
  const rec = currentRecord();
  if (!rec) { toast('⚠️ Open record first'); return; }

  // === NCR ===
  if (isNcr()) {
    if (!(canApprove() || isExecEngineer())) { toast('⛔ Only QA/Exec can reject NCR'); return; }
    if (rec.status !== 'Under Review') { toast('⚠️ Cannot reject now'); return; }
    const c = document.getElementById('wfComment').value.trim();
    if (!c) { toast('⚠️ Enter rejection/return comment'); return; }
    rec.status = 'Rejected';
    rec.comment = 'Returned for rework: ' + c;
    rec.decisionBy = currentUser.username;
    rec.decisionByDisplay = currentUser.display;
    rec.savedAt = new Date().toISOString();
    rec.audit.push(getAuditNow('Returned to Contractor', rec.comment));
    await updateReportOnServer(rec);
    updateWorkflowButtons(rec);
    toast('↩️ NCR returned to contractor');

    const linkedRfiId = rec.raisedFromRfi || rec.meta?.raisedFromRfi || '';
    if (linkedRfiId) {
      const parentRfi = savedReports.find(r => r.templateKey === 'rfi' && (r.id === linkedRfiId || r.meta?.rfiNo === linkedRfiId));
      if (parentRfi && parentRfi.createdBy) {
        await sendNotification(parentRfi.createdBy, `NCR #${rec.meta?.ncrNo || rec.id} returned for rework by ${currentUser.display}. Comment: ${c}`, 'rejected', rec.id, rec.meta?.ncrNo || rec.id, currentUser.display);
      }
    }
    // Also notify the assigned agency/agencies
const agencyUsernames = Array.isArray(rec.meta?.agency) ? rec.meta.agency : (rec.meta?.agency ? [rec.meta.agency] : []);
for (const username of agencyUsernames) {
  if (username && username !== parentRfi?.createdBy) {
    await sendNotification(
      username,
      `↩️ NCR #${rec.meta?.ncrNo || rec.id} returned for rework by ${currentUser.display}. Comment: ${c}`,
      'rejected',
      rec.id,
      rec.meta?.ncrNo || rec.id,
      currentUser.display
    );
  }
}
    return;
  }

  // === AUDIT REJECT ===
  else if (isAudit()) {
    if (!(canApprove() || isExecEngineer() || currentUser?.role === 'manager')) {
      toast('⛔ Only QA/Exec/Manager can reject audit');
      return;
    }
    if (rec.status !== 'Under Review') { toast('⚠️ Cannot reject now'); return; }
    const c = document.getElementById('wfComment').value.trim();
    if (!c) { toast('⚠️ Enter rejection/return comment'); return; }
    rec.status = 'Rejected';
    rec.comment = 'Returned for rework: ' + c;
    rec.decisionBy = currentUser.username;
    rec.decisionByDisplay = currentUser.display;
    rec.savedAt = new Date().toISOString();
    rec.audit.push(getAuditNow('Returned to Contractor', rec.comment));
    await updateReportOnServer(rec);
    updateWorkflowButtons(rec);
    toast('↩️ Audit returned to contractor');

    // Notify each selected agency
    if (rec.meta?.agency && Array.isArray(rec.meta.agency)) {
      for (const username of rec.meta.agency) {
        await sendNotification(username, `↩️ Audit #${rec.meta?.reportNo || rec.id} returned for rework by ${currentUser.display}. Comment: ${c}`, 'rejected', rec.id, rec.meta?.reportNo || rec.id, currentUser.display);
      }
    }
    const creator = rec.createdBy;
if (creator && !rec.meta?.agency?.includes(creator)) {
  await sendNotification(creator, `↩️ Audit #${rec.meta?.reportNo || rec.id} returned for rework by ${currentUser.display}. Comment: ${c}`, 'rejected', rec.id, rec.meta?.reportNo || rec.id, currentUser.display);
}
    return;
  }

  // === IMIR REJECT ===
  else if (isImir()) {
    if (!(canApprove() || isExecEngineer() || currentUser?.role === 'manager')) {
      toast('⛔ Only QA/Exec/Manager can reject IMIR');
      return;
    }
    if (rec.status !== 'Submitted') { toast('⚠️ Cannot reject now'); return; }
    const c = document.getElementById('wfComment').value.trim();
    if (!c) { toast('⚠️ Enter rejection comment'); return; }
    rec.status = 'Rejected';
    rec.comment = c;
    rec.decisionBy = currentUser.username;
    rec.decisionByDisplay = currentUser.display;
    rec.savedAt = new Date().toISOString();
    rec.audit.push(getAuditNow('Rejected', c));
    await updateReportOnServer(rec);
    updateWorkflowButtons(rec);
    toast('❌ IMIR Rejected');
    if (rec.createdBy) {
      await sendNotification(rec.createdBy, `❌ IMIR #${rec.meta?.imirNo || rec.id} Rejected by ${currentUser.display}`, 'rejected', rec.id, rec.meta?.imirNo || rec.id, currentUser.display);
    }
    return;
  }
  // === RFI ===
  const c = document.getElementById('wfComment').value.trim();
  if (!c) { toast('⚠️ Enter rejection comment'); return; }
  rec.status = 'Rejected';
  rec.comment = c;
  rec.decisionBy = currentUser.username;
  rec.decisionByDisplay = currentUser.display;
  rec.audit.push(getAuditNow('Rejected', c));
  rec.savedAt = new Date().toISOString();
  await updateReportOnServer(rec);
  updateWorkflowButtons(rec);
  toast('❌ Rejected');
  if (rec.createdBy) {
    const docNo = rec.meta?.rfiNo || rec.id || 'Unknown';
    await sendNotification(rec.createdBy, `Your ${rec.templateKey === 'imir' ? 'IMIR' : 'RFI'} #${docNo} has been Rejected by ${currentUser.display}`, 'rejected', rec.id, docNo, currentUser.display);
  }
}
async function closeRecord() {
  const rec = currentRecord();
  if (!rec) { toast('⚠️ Open record first'); return; }
    if (isNcr()) {
    if (!(canApprove() || isExecEngineer())) { toast('⛔ Only Execution Engineer, QA Head or Admin can close NCR'); return; }
    rec.status = 'Closed';
    rec.comment = document.getElementById('wfComment').value.trim() || 'Closed manually';
    rec.audit.push(getAuditNow('Closed', rec.comment));
    rec.savedAt = new Date().toISOString();
    await updateReportOnServer(rec);
    updateWorkflowButtons(rec);
    toast('🔒 Closed');
    
    // --- FIX: Use NCR instead of Audit in notification messages ---
    const creator = rec.createdBy;
    const docNo = rec.meta?.ncrNo || rec.id || 'Unknown';
    if (creator) {
      await sendNotification(creator, `NCR #${docNo} has been closed by ${currentUser.display}`, 'closed_ncr', rec.id, docNo, currentUser.display);
    }
    if (rec.meta?.agency && Array.isArray(rec.meta.agency)) {
      for (const username of rec.meta.agency) {
        if (username !== creator) {
          await sendNotification(username, `NCR #${docNo} has been closed by ${currentUser.display}`, 'closed_ncr', rec.id, docNo, currentUser.display);
        }
      }
    }
    return;
  }

  // === AUDIT CLOSE ===
  else if (isAudit()) {
    if (!(canApprove() || isExecEngineer() || currentUser?.role === 'manager')) {
      toast('⛔ Only QA/Exec/Manager can close audit');
      return;
    }
    rec.status = 'Closed';
    rec.comment = document.getElementById('wfComment').value.trim() || 'Closed manually';
    rec.audit.push(getAuditNow('Closed', rec.comment));
    rec.savedAt = new Date().toISOString();
    await updateReportOnServer(rec);
    updateWorkflowButtons(rec);
    toast('🔒 Audit Closed');
    return;
  }

  toast('⚠️ Not applicable');
}
// ============================================================
// 18. CHECKLIST LINKING (unchanged)
// ============================================================
function captureCurrentRfiPrefill() {
  return {
    project: document.getElementById('meta_project')?.value || '',
    package: document.getElementById('meta_package')?.value || '',
    contractor: document.getElementById('meta_contractor')?.value || '',
    projectCode: document.getElementById('meta_projectCode')?.value || '',
    date: document.getElementById('meta_date')?.value || ''
  };
}
async function launchChecklistFromRfi(templateKey) {
  if (activeTemplateKey !== 'rfi') {
    toast('⚠️ Open an RFI first');
    return;
  }
  const rfiNoEl = document.getElementById('meta_rfiNo');
  const rfiNo = (rfiNoEl?.value || '').trim();
  if (!rfiNo) {
    toast('⚠️ Enter RFI No first');
    rfiNoEl?.focus();
    return;
  }
  
  // Save the RFI and wait for completion
  try {
    await saveReport({ preventDefault() {} });
  } catch (e) {
    toast('❌ Failed to save RFI: ' + e.message);
    return;
  }
  // --- ADD THIS VERIFICATION ---
  const savedRfi = currentRecord();
  if (!savedRfi || !savedRfi.meta?.rfiNo || savedRfi.meta.rfiNo.trim() === '') {
    toast('⚠️ Please enter a valid RFI No. and save the RFI before adding a checklist.');
    return;
  }
  // -------------------------
  const parent = currentRecord();
  if (!parent || activeTemplateKey !== 'rfi') {
    toast('⚠️ Please save RFI first');
    return;
  }
  if (!canAddChecklistToRfi(parent)) {
    toast('⚠️ Cannot add checklist after approval/rejection');
    return;
  }
  pendingLinkedRfiNo = rfiNo;
  pendingReturnRfiId = parent.id;
  pendingParentMeta = captureCurrentRfiPrefill();
  openTemplate(templateKey);
}
async function launchactivityChecklist(templateKey) {
  if (activeTemplateKey !== 'audit') {
    toast('⚠️ Open an Audit Report first');
    return;
  }
  const reportNoEl = document.getElementById('meta_reportNo');
  const reportNo = (reportNoEl?.value || '').trim();
  if (!reportNo) {
    toast('⚠️ Enter Report No first');
    reportNoEl?.focus();
    return;
  }
  
  try {
    await saveReport({ preventDefault() {} });   // ✅ added await
  } catch (e) {
    toast('❌ Failed to save Audit: ' + e.message);
    return;
  }
  
  const parent = currentRecord();
  if (!parent || activeTemplateKey !== 'audit') {
    toast('⚠️ Please save Audit first');
    return;
  }
  
  pendingReturnRfiId = parent.id;
  pendingLinkedAuditNo = reportNo;
  openTemplate(templateKey);
}
// ============================================================
// LAUNCH COMPLIANCE CHECKLIST FROM AUDIT
// ============================================================
async function launchComplianceChecklist(auditReport) {
  if (!auditReport) {
    toast('⚠️ Please save the Audit first');
    return;
  }

  const reportNo = auditReport.meta?.reportNo || auditReport.id;
  if (!reportNo) {
    toast('⚠️ Please enter Report No first');
    return;
  }

  // ---- CHECK IF COMPLIANCE REPORT IS ALREADY LINKED ----
  const alreadyLinked = savedReports.some(r =>
    r.templateKey === 'compliance_report' &&
    (r.meta?.linkedAudit === reportNo || r.meta?.linkedAudit === auditReport.id)
  );
  if (alreadyLinked) {
    toast('ℹ️ A Compliance Report is already linked to this Audit. Open it from the Audit Records page.');
    return;   // prevent duplicate
  }

  // Save the audit first
  try {
    await saveReport({ preventDefault() {} });
  } catch (e) {
    toast('❌ Failed to save Audit: ' + e.message);
    return;
  }

  pendingReturnRfiId = auditReport.id;
  pendingLinkedAuditNo = reportNo;
  pendingParentMeta = {
    project: auditReport.meta?.project || '',
    auditor: auditReport.meta?.auditor || '',
    auditFrom: auditReport.meta?.auditDate || '',
    auditorName: auditReport.meta?.auditor || ''
  };
  openTemplate('compliance_report');
}

let pendingLinkedAuditNo = null;  
function openLinkedChecklistFromRfi(checklistId, parentRfiId) {
  const chk = savedReports.find(r => r.id === checklistId);
  if (!chk) { toast('⚠️ Checklist not found'); return; }
  pendingReturnRfiId = parentRfiId || null;
  openTemplate(chk.templateKey, chk.id);
}
function applyPendingChecklistPrefill() {
  if (activeTemplateKey === 'rfi') return;
  if (pendingLinkedRfiNo) {
    const sel = document.getElementById('meta_linkedRfi');
    if (sel) {
      const exists = Array.from(sel.options).some(o => o.value === pendingLinkedRfiNo);
      if (!exists) { const opt = document.createElement('option'); opt.value = pendingLinkedRfiNo; opt.textContent = pendingLinkedRfiNo; sel.appendChild(opt); }
      sel.value = pendingLinkedRfiNo;
    }
  }
  const m = pendingParentMeta || {};
  const map = { project: 'meta_project', package: 'meta_package', contractor: 'meta_contractor', projectCode: 'meta_projectCode', date: 'meta_date' };
  Object.entries(map).forEach(([k, id]) => {
    const el = document.getElementById(id);
    if (el && m[k] && !el.value) el.value = m[k];
  });
}

// ============================================================
// 19. OPEN TEMPLATE / RECORD
// ============================================================
async function openTemplate(key, reportId = null, reportObj = null) {
  activeTemplateKey = key;
  activeReportId = reportId;
  const t = templates[key];
   // ← ADD THIS ↓↓↓
  // Load agency users for Audit or NCR
  if (key === 'audit' || key === 'ncr') {
    await loadAgencyUsers();   // <-- ADDED 'await' HERE
  }
  // ← ADD THIS ↑↑↑
  // Use reportObj if provided, otherwise look up in savedReports
  const report = reportObj || (reportId ? savedReports.find(r => r.id === reportId) : null);
   // Auto-populate linked RFI for checklists
  if (pendingLinkedRfiNo && activeTemplateKey !== 'rfi') {
    const sel = document.getElementById('meta_linkedRfi');
    if (sel) {
      const exists = Array.from(sel.options).some(o => o.value === pendingLinkedRfiNo);
      if (!exists) {
        const opt = document.createElement('option');
        opt.value = pendingLinkedRfiNo;
        opt.textContent = pendingLinkedRfiNo;
        sel.appendChild(opt);
      }
      sel.value = pendingLinkedRfiNo;
    }
  }
    // ★ NEW: For activity checklists, auto-populate the Linked Audit dropdown
  if (pendingLinkedAuditNo && activeTemplateKey !== 'audit') {
    const sel = document.getElementById('meta_linkedAudit');
    if (sel) {
      const exists = Array.from(sel.options).some(o => o.value === pendingLinkedAuditNo);
      if (!exists) {
        const opt = document.createElement('option');
        opt.value = pendingLinkedAuditNo;
        opt.textContent = pendingLinkedAuditNo;
        sel.appendChild(opt);
      }
      sel.value = pendingLinkedAuditNo;
    }
  }
  document.getElementById('sheetOrg').innerText = appConfig.companyName || 'QA/QC Suite';
  document.getElementById('sheetDept').innerText = t.dept || 'QA / QC RECORDS';
  document.getElementById('fmtNo').innerText = 'Format No. - ' + (t.formatNo || buildFormatNo('01'));
  document.getElementById('sheetTitle').innerText = t.title;

  document.getElementById('appTitle').innerText = t.menuTitle;
  document.getElementById('appSub').innerText = t.formatNo || '';

  renderSheet(t, report);
  applyPendingChecklistPrefill();
  updateWorkflowButtons(report);
  setChecklistButtonsState(report);
  switchView('form');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
 async function openRecord(id) {
  // 1. Try to find the record in local cache
  let r = savedReports.find(x => x.id === id);
  if (!r) {
    toast('Record not found');
    return;
  }

  try {
    // 2. Fetch the full record from server (includes image data)
    const full = await apiRequest(`/api/reports/${id}`);

    // 3. Normalise agency for audit reports
    let meta = full.meta || {};
    if (full.template_key === 'audit' && meta.agency) {
      if (typeof meta.agency === 'string') {
        try {
          const parsed = JSON.parse(meta.agency);
          meta.agency = Array.isArray(parsed) ? parsed : [meta.agency];
        } catch {
          meta.agency = [meta.agency];
        }
      } else if (!Array.isArray(meta.agency)) {
        meta.agency = [meta.agency];
      }
    }

    // 4. Build the full report object
    r = {
      id: full.id,
      templateKey: full.template_key,
      templateName: full.template_name,
      formatNo: full.format_no,
      meta: meta,                         // use normalised meta
      sections: full.sections || [],
      score: full.score || 0,
      defectsCount: full.defects_count || 0,
      titleLoc: full.title_loc || '',
      preparedBy: full.prepared_by || '',
      status: full.status || 'Draft',
      comment: full.comment || '',
      attachments: full.attachments || [],   // full data with images
      createdBy: full.created_by || '',
      createdByDisplay: full.created_by_display || '',
      decisionBy: full.decision_by || '',
      decisionByDisplay: full.decision_by_display || '',
      savedAt: full.saved_at || '',
      audit: full.audit || [],
      raisedFromRfi: full.raised_from_rfi || '',
      siteName: full.site_name || ''
    };

    // 5. Update the local cache with the full data (so next time it's already there)
    const idx = savedReports.findIndex(x => x.id === id);
    if (idx >= 0) savedReports[idx] = r;
    else savedReports.unshift(r);

    // 6. Permission check
    if (!canUserSeeRecord(r, currentUser)) {
      toast('⛔ Access denied');
      return;
    }

    // 7. Open the template with the full record
    openTemplate(r.templateKey, r.id, r);
    return;

  } catch (e) {
  // 8. Offline fallback – use cached version (images may be missing)
  toast('⚠️ Showing cached version. Images may not be shown. Click "Refresh" to retry.');
  
   // Permission check for cached version
   if (!canUserSeeRecord(r, currentUser)) {
     toast('⛔ Access denied');
     return;
   }
   openTemplate(r.templateKey, r.id);
 }
}
// ============================================================
// 20. STATS & DASHBOARD
// ============================================================
function updateStats() {
  const rows = visibleReports();
  const rfis = rows.filter(r => r.templateKey === 'rfi');
  const ncrs = rows.filter(r => r.templateKey === 'ncr');
  const imirs = rows.filter(r => r.templateKey === 'imir');

  // --- RFI stats ---
  const approvedOnly = rfis.filter(r => r.status === 'Approved' || r.status === 'Closed').length;
  const approvedWithComment = rfis.filter(r => r.status === 'Approved with Comment').length;
  const allApproved = approvedOnly + approvedWithComment;
  const submittedPool = rfis.filter(r => ['Submitted', 'Under Review', 'Approved by Execution', 'Approved', 'Approved with Comment', 'Rejected', 'Closed'].includes(r.status));
  const approvalPct = submittedPool.length ? Math.round((allApproved / submittedPool.length) * 100) : 0;
  document.getElementById('totalRfiRaised').innerText = rfis.length;
  document.getElementById('avgCompliance').innerText = approvalPct + '%';
  document.getElementById('pendingRfi').innerText = rfis.filter(r => ['Draft', 'Submitted', 'Under Review'].includes(r.status)).length;
  document.getElementById('approvedRfi').innerText = allApproved;
  document.getElementById('rejectedRfi').innerText = rfis.filter(r => r.status === 'Rejected').length;

  // --- NCR stats ---
  const ncrTotal = ncrs.length;
  const ncrClosed = ncrs.filter(r => r.status === 'Closed').length;
  const ncrOpen = ncrTotal - ncrClosed;
  const ncrClosedPct = ncrTotal ? Math.round((ncrClosed / ncrTotal) * 100) : 0;
  const ncrOpenPct = ncrTotal ? Math.round((ncrOpen / ncrTotal) * 100) : 0;
  document.getElementById('ncrOpenPct').innerText = ncrOpenPct + '%';
  document.getElementById('ncrTotal').innerText = ncrTotal;
  document.getElementById('ncrOpen').innerText = ncrOpen;
  document.getElementById('ncrClosed').innerText = ncrClosed;
  document.getElementById('ncrClosedPct').innerText = ncrClosedPct + '%';

  // --- IMIR stats ---
  const imirTotal = imirs.length;
  const imirApproved = imirs.filter(r => r.status === 'Approved').length;
  const imirRejected = imirs.filter(r => r.status === 'Rejected').length;
  const imirPending = imirs.filter(r => r.status !== 'Approved' && r.status !== 'Rejected').length;
  document.getElementById('imirTotal').innerText = imirTotal;
  document.getElementById('imirApproved').innerText = imirApproved;
  document.getElementById('imirRejected').innerText = imirRejected;
  document.getElementById('imirPending').innerText = imirPending;
  renderRfiChart('rfi');
  if (currentKpiFilter) filterKPI(currentKpiFilter);
  updateNotificationUI();
}
// ============================================================
// DYNAMIC STATUS BAR CHART (RFI, NCR, IMIR)
// ============================================================
let rfiChartInstance = null;

function renderRfiChart(type = 'rfi') {
  const canvas = document.getElementById('rfiStatusChart');
  if (!canvas) return;

  let records = [];
  let title = '';
  let statuses = [];
  let colors = {};

  // Determine which records to show based on type
  if (type === 'rfi') {
    records = savedReports.filter(r => r.templateKey === 'rfi');
    title = 'RFI Status Distribution';
    statuses = ['Draft', 'Submitted', 'Under Review', 'Approved by Execution', 'Approved', 'Approved with Comment', 'Rejected', 'Closed'];
    colors = {
      'Draft': '#6c757d',
      'Submitted': '#f0a202',
      'Under Review': '#17a2b8',
      'Approved by Execution': '#fd7e14',
      'Approved': '#28a745',
      'Approved with Comment': '#ffc107',
      'Rejected': '#dc3545',
      'Closed': '#6f42c1'
    };
  } else if (type === 'ncr') {
    records = savedReports.filter(r => r.templateKey === 'ncr');
    title = 'NCR Status Distribution';
    statuses = ['Draft', 'Open', 'Under Review', 'Approved', 'Rejected', 'Closed'];
    colors = {
      'Draft': '#6c757d',
      'Open': '#f0a202',
      'Under Review': '#17a2b8',
      'Approved': '#28a745',
      'Rejected': '#dc3545',
      'Closed': '#6f42c1'
    };
  } else if (type === 'imir') {
    records = savedReports.filter(r => r.templateKey === 'imir');
    title = 'IMIR Status Distribution';
    statuses = ['Draft', 'Submitted', 'Approved', 'Rejected'];
    colors = {
      'Draft': '#6c757d',
      'Submitted': '#f0a202',
      'Approved': '#28a745',
      'Rejected': '#dc3545'
    };
  } else {
    // fallback to RFI
    records = savedReports.filter(r => r.templateKey === 'rfi');
    title = 'RFI Status Distribution';
    statuses = ['Draft', 'Submitted', 'Under Review', 'Approved by Execution', 'Approved', 'Approved with Comment', 'Rejected', 'Closed'];
    colors = {
      'Draft': '#6c757d',
      'Submitted': '#f0a202',
      'Under Review': '#17a2b8',
      'Approved by Execution': '#fd7e14',
      'Approved': '#28a745',
      'Approved with Comment': '#ffc107',
      'Rejected': '#dc3545',
      'Closed': '#6f42c1'
    };
  }

  const counts = statuses.map(status => {
    return records.filter(r => (r.status || 'Draft') === status).length;
  });
  const bgColors = statuses.map(s => colors[s] || '#6c757d');

  // Destroy existing chart
  if (rfiChartInstance) {
    rfiChartInstance.destroy();
    rfiChartInstance = null;
  }

  // Dark mode styling
  const isDark = document.body.classList.contains('dark-mode');
  const textColor = isDark ? '#eef4fa' : '#111';
  const gridColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)';

  const ctx = canvas.getContext('2d');
  rfiChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: statuses,
      datasets: [{
        label: 'Number of Records',
        data: counts,
        backgroundColor: bgColors,
        borderColor: '#123a66',
        borderWidth: 1,
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        title: {
          display: true,
          text: title,
          color: textColor,
          font: { size: 14, weight: 'bold' }
        },
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(context) {
              return context.parsed.y + ' record(s)';
            }
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            stepSize: 1,
            font: { size: 11 },
            color: textColor
          },
          grid: { color: gridColor }
        },
        x: {
          ticks: {
            font: { size: 10 },
            maxRotation: 45,
            minRotation: 30,
            color: textColor
          },
          grid: { display: false }
        }
      }
    }
  });
}
function recordDateKey(rec) {
  const raw = rec.meta?.date || rec.savedAt || '';
  if (!raw) return '';
  const m = String(raw).match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(raw);
  if (String(d) === 'Invalid Date') return '';
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function visibleReports() {
  let rows = savedReports.slice();
  if (globalFilterState.project) {
    rows = rows.filter(r => String(r.meta?.project || r.titleLoc || '').toLowerCase().includes(globalFilterState.project.toLowerCase()));
  }
  if (globalFilterState.type) {
    rows = rows.filter(r => r.templateKey === globalFilterState.type);
  }
  if (globalFilterState.contractor) {
    rows = rows.filter(r => String(r.meta?.contractor || '').toLowerCase().includes(globalFilterState.contractor.toLowerCase()));
  }
  if (globalFilterState.discipline) {
    rows = rows.filter(r => String(r.meta?.discipline || '').toLowerCase().includes(globalFilterState.discipline.toLowerCase()));
  }
  if (globalFilterState.status) {
    rows = rows.filter(r => (r.status || 'Draft') === globalFilterState.status);
  }
  if (globalFilterState.fromDate) {
    rows = rows.filter(r => (r.meta?.date || r.savedAt || '') >= globalFilterState.fromDate);
  }
  if (globalFilterState.toDate) {
    rows = rows.filter(r => (r.meta?.date || r.savedAt || '') <= globalFilterState.toDate);
  }
  if (globalFilterState.owner) {
    rows = rows.filter(r => String(r.createdByDisplay || '').toLowerCase().includes(globalFilterState.owner.toLowerCase()));
  }
  if (!currentUser) return [];
  rows = rows.filter(r => canUserSeeRecord(r, currentUser));
  return rows;
}
function getHistoryFilteredRows() { return visibleReports(); }
function renderHistory(showAll = false) {
  const body = document.getElementById('historyBody');
  body.innerHTML = '';
  const allRows = getHistoryFilteredRows();
  if (!allRows.length) {
    body.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#666;">No records found.</td></tr>';
    return;
  }

  const limit = showAll ? Infinity : 50;
  const rows = allRows.slice(0, limit);
  const hasMore = !showAll && allRows.length > limit;

  const rfiRows = rows.filter(r => r.templateKey === 'rfi');
  const otherRows = rows.filter(r => r.templateKey !== 'rfi');

  const checklistMap = new Map();
  const ncrMap = new Map();

  otherRows.forEach(chk => {
    if (chk.templateKey === 'ncr') {
      const key = chk.raisedFromRfi || chk.meta?.raisedFromRfi || '__standalone__';
      if (!ncrMap.has(key)) ncrMap.set(key, []);
      ncrMap.get(key).push(chk);
    } else {
      const key = chk.templateKey === 'imir' ? '__standalone__' : (chk.meta?.linkedRfi || '__unlinked__');
      if (!checklistMap.has(key)) checklistMap.set(key, []);
      checklistMap.get(key).push(chk);
    }
  });

  const standaloneChecklists = checklistMap.get('__standalone__') || [];
  standaloneChecklists.forEach(r => {
    const scoreBadge = typeof r.score === 'number' ? `<span class="badge ${r.score < 60 ? 'bad' : r.score < 85 ? 'mid' : 'ok'}">${r.score}%</span>` : '<span class="badge mid">N/A</span>';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${fmtDateTime(r.savedAt || r.meta?.date)}</td>
      <td><b>${esc(r.templateName)}</b><br><span class="small">${esc(r.formatNo)}</span></td>
      <td>${esc(r.titleLoc || '-')}</td>
      <td>${esc(r.preparedBy || '-')}<br><span class="small">Owner: ${esc(r.createdByDisplay || '-')}</span></td>
      <td>${badgeForStatus(r.status || 'Draft')}</td>
      <td>${r.defectsCount || 0}</td>
      <td>${scoreBadge}</td>
      <td><button class="btn btn-secondary" style="padding:6px 10px;font-size:12px;" onclick="openRecord('${r.id}')">Open</button> ${canDeleteRecord(r) ? `<button class="btn btn-danger" style="padding:6px 10px;font-size:12px;" onclick="deleteReport('${r.id}')">Delete</button>` : ''}</td>`;
    body.appendChild(tr);
  });

  const standaloneNCRs = ncrMap.get('__standalone__') || [];
  standaloneNCRs.forEach(r => {
    const scoreBadge = typeof r.score === 'number' ? `<span class="badge ${r.score < 60 ? 'bad' : r.score < 85 ? 'mid' : 'ok'}">${r.score}%</span>` : '<span class="badge mid">N/A</span>';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${fmtDateTime(r.savedAt || r.meta?.date)}</td>
      <td><b>${esc(r.templateName)}</b><br><span class="small">${esc(r.formatNo)}</span></td>
      <td>${esc(r.titleLoc || '-')}</td>
      <td>${esc(r.preparedBy || '-')}<br><span class="small">Owner: ${esc(r.createdByDisplay || '-')}</span></td>
      <td>${badgeForStatus(r.status || 'Draft')}</td>
      <td>${r.defectsCount || 0}</td>
      <td>${scoreBadge}</td>
      <td><button class="btn btn-secondary" style="padding:6px 10px;font-size:12px;" onclick="openRecord('${r.id}')">Open</button> ${canDeleteRecord(r) ? `<button class="btn btn-danger" style="padding:6px 10px;font-size:12px;" onclick="deleteReport('${r.id}')">Delete</button>` : ''}</td>`;
    body.appendChild(tr);
  });

  rfiRows.forEach(r => {
    const linkedKey = r.meta?.rfiNo || r.id;
    const linkedChecklists = (checklistMap.get(linkedKey) || []).filter(chk => canUserSeeRecord(chk, currentUser));
    const linkedNCRs = (ncrMap.get(linkedKey) || []).filter(chk => canUserSeeRecord(chk, currentUser));
    const allLinked = [...linkedChecklists, ...linkedNCRs];
    const scoreBadge = typeof r.score === 'number' ? `<span class="badge ${r.score < 60 ? 'bad' : r.score < 85 ? 'mid' : 'ok'}">${r.score}%</span>` : '<span class="badge mid">N/A</span>';
    const tr = document.createElement('tr');
    tr.className = 'parent-rfi-row';
    tr.innerHTML = `
      <td>${fmtDateTime(r.savedAt || r.meta?.date)}</td>
      <td><b>${esc(r.templateName)}</b><br><span class="small">${esc(r.formatNo)}</span></td>
      <td>${esc(r.titleLoc || '-')}</td>
      <td>${esc(r.preparedBy || '-')}<br><span class="small">Owner: ${esc(r.createdByDisplay || '-')}</span><br><span class="small">Linked: ${allLinked.length}</span></td>
      <td>${badgeForStatus(r.status || 'Draft')}</td>
      <td>${r.defectsCount || 0}</td>
      <td>${scoreBadge}</td>
      <td><button class="btn btn-secondary" style="padding:6px 10px;font-size:12px;" onclick="openRecord('${r.id}')">Open</button> ${canDeleteRecord(r) ? `<button class="btn btn-danger" style="padding:6px 10px;font-size:12px;" onclick="deleteReport('${r.id}')">Delete</button>` : ''}</td>`;
    body.appendChild(tr);

    linkedChecklists.forEach(chk => {
      const chkScoreBadge = typeof chk.score === 'number' ? `<span class="badge ${chk.score < 60 ? 'bad' : chk.score < 85 ? 'mid' : 'ok'}">${chk.score}%</span>` : '<span class="badge mid">N/A</span>';
      const child = document.createElement('tr');
      child.className = 'child-row';
      child.innerHTML = `
        <td>${fmtDateTime(chk.savedAt || chk.meta?.date)}</td>
        <td style="padding-left:28px;"><span class="small">↳ Linked Checklist</span><br><b>${esc(chk.templateName)}</b><br><span class="small">${esc(chk.formatNo)}</span></td>
        <td>${esc(chk.titleLoc || '-')}<br><span class="small">Linked to: ${esc(chk.meta?.linkedRfi || '-')}</span></td>
        <td>${esc(chk.preparedBy || '-')}<br><span class="small">Owner: ${esc(chk.createdByDisplay || '-')}</span></td>
        <td>${badgeForStatus(chk.status || 'Closed')}</td>
        <td>${chk.defectsCount || 0}</td>
        <td>${chkScoreBadge}</td>
        <td><button class="btn btn-secondary" style="padding:6px 10px;font-size:12px;" onclick="openRecord('${chk.id}')">Open</button> ${canDeleteRecord(chk) ? `<button class="btn btn-danger" style="padding:6px 10px;font-size:12px;" onclick="deleteReport('${chk.id}')">Delete</button>` : ''}</td>`;
      body.appendChild(child);
    });

    linkedNCRs.forEach(chk => {
      const chkScoreBadge = typeof chk.score === 'number' ? `<span class="badge ${chk.score < 60 ? 'bad' : chk.score < 85 ? 'mid' : 'ok'}">${chk.score}%</span>` : '<span class="badge mid">N/A</span>';
      const child = document.createElement('tr');
      child.className = 'child-row';
      child.innerHTML = `
        <td>${fmtDateTime(chk.savedAt || chk.meta?.date)}</td>
        <td style="padding-left:28px;"><span class="small">↳ Linked NCR</span><br><b>${esc(chk.templateName)}</b><br><span class="small">${esc(chk.formatNo)}</span></td>
        <td>${esc(chk.titleLoc || '-')}<br><span class="small">Raised from RFI: ${esc(chk.raisedFromRfi || chk.meta?.raisedFromRfi || '-')}</span></td>
        <td>${esc(chk.preparedBy || '-')}<br><span class="small">Owner: ${esc(chk.createdByDisplay || '-')}</span></td>
        <td>${badgeForStatus(chk.status || 'Draft')}</td>
        <td>${chk.defectsCount || 0}</td>
        <td>${chkScoreBadge}</td>
        <td><button class="btn btn-secondary" style="padding:6px 10px;font-size:12px;" onclick="openRecord('${chk.id}')">Open</button> ${canDeleteRecord(chk) ? `<button class="btn btn-danger" style="padding:6px 10px;font-size:12px;" onclick="deleteReport('${chk.id}')">Delete</button>` : ''}</td>`;
      body.appendChild(child);
    });
  });

  // --- If there are more records, add a "Load All" button ---
  if (hasMore) {
    const loadMoreRow = document.createElement('tr');
    loadMoreRow.innerHTML = `
      <td colspan="8" style="text-align:center; padding:12px;">
        <button class="btn btn-primary" onclick="loadAllHistory()">
          📂 Load All (${allRows.length - limit} more records)
        </button>
      </td>
    `;
    body.appendChild(loadMoreRow);
  }
}
function loadAllHistory() {
  renderHistory(true);
}
// ============================================================
// 22. KPI FILTERING
// ============================================================
function kpiLabel(type) {
  const map = {
    total: 'All RFI',
    approval: 'Approved RFI',
    pending: 'Pending RFI',
    approved: 'Approved RFI',
    rejected: 'Rejected RFI',
    ncr_total: 'All NCR',
    ncr_open: 'Open NCR',
    ncr_closed: 'Closed NCR',
    ncr_open_pct: 'NCR Open %',
    ncr_closed_pct: 'NCR Closed %',
    // Add IMIR labels
    imir_total: 'All IMIR',
    imir_approved: 'Approved IMIR',
    imir_rejected: 'Rejected IMIR',
    imir_pending: 'Pending IMIR'
  };
  return map[type] || 'Filtered';
}
function kpiStatusClass(status) {
  if (status === 'Approved' || status === 'Closed') return 'approved';
  if (status === 'Approved with Comment') return 'comment';
  if (status === 'Rejected') return 'rejected';
  if (status === 'Approved by Execution') return 'exec_approved';
  return 'pending';
}
function setActiveKpiCard(type) {
  document.querySelectorAll('.dashboard-grid .stat[data-kpi]').forEach(card => {
    card.classList.toggle('active-kpi', card.getAttribute('data-kpi') === type);
  });
}
function filterKPI(type) {
  const sourceRows = visibleReports();
  let filtered = [];
  let title = 'All Records';
  let sub = 'Showing all records.';

  // --- RFI filters ---
  if (type === 'total' || type === 'approval' || type === 'pending' || type === 'approved' || type === 'rejected') {
    const rfis = sourceRows.filter(r => r.templateKey === 'rfi');
    if (type === 'total') filtered = rfis;
    else if (type === 'approval') filtered = rfis.filter(r => ['Approved', 'Approved with Comment'].includes(r.status));
    else if (type === 'pending') filtered = rfis.filter(r => ['Draft', 'Submitted', 'Under Review'].includes(r.status));
    else if (type === 'approved') filtered = rfis.filter(r => r.status === 'Approved' || r.status === 'Closed');
    else if (type === 'rejected') filtered = rfis.filter(r => r.status === 'Rejected');
    title = 'RFI List';
    sub = 'Showing RFI records.';
  }
  // --- NCR filters ---
  else if (type === 'ncr_total' || type === 'ncr_open' || type === 'ncr_closed' || type === 'ncr_closed_pct' || type === 'ncr_open_pct') {
    const ncrs = sourceRows.filter(r => r.templateKey === 'ncr');
    if (type === 'ncr_total') filtered = ncrs;
    else if (type === 'ncr_open' || type === 'ncr_open_pct') filtered = ncrs.filter(r => r.status !== 'Closed');
    else if (type === 'ncr_closed' || type === 'ncr_closed_pct') filtered = ncrs.filter(r => r.status === 'Closed');
    title = 'NCR List';
    sub = 'Showing NCR records.';
  }
  // --- IMIR filters ---
  else if (type === 'imir_total' || type === 'imir_approved' || type === 'imir_rejected' || type === 'imir_pending') {
    const imirs = sourceRows.filter(r => r.templateKey === 'imir');
    if (type === 'imir_total') filtered = imirs;
    else if (type === 'imir_approved') filtered = imirs.filter(r => r.status === 'Approved');
    else if (type === 'imir_rejected') filtered = imirs.filter(r => r.status === 'Rejected');
    else if (type === 'imir_pending') filtered = imirs.filter(r => r.status !== 'Approved' && r.status !== 'Rejected');
    title = 'IMIR List';
    sub = 'Showing IMIR records.';
  }

  currentKpiFilter = type;
  currentKpiRows = filtered.slice();
  renderKPIResults(filtered, type, title, sub);

  // Update chart based on KPI type
  let chartType = 'rfi';
  if (type === 'total' || type === 'approval' || type === 'pending' || type === 'approved' || type === 'rejected') chartType = 'rfi';
  else if (type === 'ncr_total' || type === 'ncr_open' || type === 'ncr_closed' || type === 'ncr_closed_pct' || type === 'ncr_open_pct') chartType = 'ncr';
  else if (type === 'imir_total' || type === 'imir_approved' || type === 'imir_rejected' || type === 'imir_pending') chartType = 'imir';
  renderRfiChart(chartType);
  setActiveKpiCard(type);
}
function renderKPIResults(data, type, customTitle, customSub) {
  const body = document.getElementById('kpiResultBody');
  const chip = document.getElementById('kpiActiveFilterChip');
  const count = document.getElementById('kpiRecordCount');
  const title = document.getElementById('kpiPanelTitle');
  const sub = document.getElementById('kpiPanelSub');

  if (chip) chip.textContent = 'Active Filter: ' + kpiLabel(type);
  if (count) count.textContent = data.length + (data.length === 1 ? ' record' : ' records');
  if (title) title.textContent = customTitle || 'All Records';
  if (sub) sub.textContent = customSub || 'Showing records.';

  if (!body) return;
  if (!data.length) {
    body.innerHTML = '<tr><td colspan="7" class="kpi-empty">No records found for this filter.</td></tr>';
    return;
  }
  body.innerHTML = data.map(r => {
    const idDisplay = r.meta?.rfiNo || r.meta?.ncrNo || r.id || '-';
    const typeLabel = r.templateKey === 'rfi' ? 'RFI' : (r.templateKey === 'ncr' ? 'NCR' : (r.templateKey === 'imir' ? 'IMIR' : r.templateName));
    return `
    <tr>
      <td><b>${esc(idDisplay)}</b></td>
      <td>${esc(typeLabel)}</td>
      <td>${esc(r.meta?.project || r.titleLoc || '-')}</td>
      <td><span class="kpi-status ${kpiStatusClass(r.status || '')}">${esc(r.status || 'Draft')}</span></td>
      <td>${esc(r.createdByDisplay || '-')}</td>
      <td>${fmtDateTime(r.savedAt || r.meta?.date)}</td>
      <td><button class="btn btn-secondary" style="padding:6px 10px;font-size:12px;" onclick="openRecord('${r.id}')">Open</button></td>
    </tr>
  `}).join('');
} 
// ============================================================
// AUDIT DASHBOARD – STATS & RENDERING
// ============================================================
let currentAuditKpiFilter = 'audit_total';

function getAuditRecords() {
  // Ignore global filter – show all audits the user is allowed to see
  return savedReports.filter(r => r.templateKey === 'audit' && canUserSeeRecord(r, currentUser));
}
function updateAuditStats() {
  const audits = getAuditRecords();
  const total = audits.length;
  const pending = audits.filter(r => ['Draft', 'Submitted', 'Under Review'].includes(r.status)).length;
  const approved = audits.filter(r => r.status === 'Approved' || r.status === 'Approved with Comment').length;
  const rejected = audits.filter(r => r.status === 'Rejected').length;
  const closed = audits.filter(r => r.status === 'Closed').length;

  document.getElementById('auditTotal').innerText = total;
  document.getElementById('auditPending').innerText = pending;
  document.getElementById('auditApproved').innerText = approved;
  document.getElementById('auditRejected').innerText = rejected;
  document.getElementById('auditClosed').innerText = closed;

  if (currentAuditKpiFilter) filterAuditKPI(currentAuditKpiFilter);
}

function filterAuditKPI(type) {
  const audits = getAuditRecords();
  let filtered = [];
  let title = 'All Audits';
  let sub = 'Showing all audit records.';

  if (type === 'audit_total') filtered = audits;
  else if (type === 'audit_pending') filtered = audits.filter(r => ['Draft', 'Submitted', 'Under Review'].includes(r.status));
  else if (type === 'audit_approved') filtered = audits.filter(r => r.status === 'Approved' || r.status === 'Approved with Comment');
  else if (type === 'audit_rejected') filtered = audits.filter(r => r.status === 'Rejected');
  else if (type === 'audit_closed') filtered = audits.filter(r => r.status === 'Closed');

  currentAuditKpiFilter = type;
  renderAuditKPIResults(filtered, type, title, sub);
  setActiveAuditKpiCard(type);
}

function setActiveAuditKpiCard(type) {
  document.querySelectorAll('.dashboard-grid .stat[data-audit-kpi]').forEach(card => {
    card.classList.toggle('active-kpi', card.getAttribute('data-audit-kpi') === type);
  });
}

function renderAuditKPIResults(data, type, customTitle, customSub) {
  const body = document.getElementById('auditKpiResultBody');
  const chip = document.getElementById('auditActiveFilterChip');
  const count = document.getElementById('auditRecordCount');
  const title = document.getElementById('auditKpiPanelTitle');
  const sub = document.getElementById('auditKpiPanelSub');

  const labels = {
    audit_total: 'All Audits',
    audit_pending: 'Pending Audits',
    audit_approved: 'Approved Audits',
    audit_rejected: 'Rejected Audits',
    audit_closed: 'Closed Audits'
  };

  if (chip) chip.textContent = 'Active Filter: ' + (labels[type] || 'All');
  if (count) count.textContent = data.length + (data.length === 1 ? ' record' : ' records');
  if (title) title.textContent = customTitle || 'All Audits';
  if (sub) sub.textContent = customSub || 'Showing audit records.';

  if (!body) return;
  if (!data.length) {
    body.innerHTML = '<tr><td colspan="7" class="kpi-empty">No audit records found for this filter.</td></tr>';
    return;
  }

  body.innerHTML = data.map(r => {
    const reportNo = r.meta?.reportNo || r.id || '-';
    const project = r.meta?.project || r.titleLoc || '-';
    const auditor = r.meta?.auditor || '-';
    const statusClass = kpiStatusClass(r.status || '');
    return `
    <tr>
      <td><b>${esc(reportNo)}</b></td>
      <td>${esc(project)}</td>
      <td><span class="kpi-status ${statusClass}">${esc(r.status || 'Draft')}</span></td>
      <td>${esc(auditor)}</td>
      <td>${esc(r.createdByDisplay || '-')}</td>
      <td>${fmtDateTime(r.savedAt || r.meta?.auditDate)}</td>
      <td><button class="btn btn-secondary" style="padding:6px 10px;font-size:12px;" onclick="openRecord('${r.id}')">Open</button></td>
    </tr>
  `}).join('');
}
// ============================================================
// RENDER AUDIT RECORDS WITH LINKED DOCUMENTS
function renderAuditRecords(containerId = 'auditRecordsBodyV2', badgeId = 'auditRecordCountBadgeV2', showAll = false) {
  const tbody = document.getElementById(containerId);
  const badge = document.getElementById(badgeId);
  if (!tbody) return;

  // Get all audits the user can see
  let audits = savedReports.filter(r => r.templateKey === 'audit' && canUserSeeRecord(r, currentUser));

  // Sort by saved date (newest first)
  audits.sort((a, b) => {
    const dateA = new Date(a.savedAt || a.meta?.auditDate || 0);
    const dateB = new Date(b.savedAt || b.meta?.auditDate || 0);
    return dateB - dateA;
  });

  if (audits.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="kpi-empty">No audits found.</td></tr>';
    if (badge) badge.textContent = '0 records';
    return;
  }

  // --- Pagination: show only 20 initially ---
  const limit = showAll ? Infinity : 20;
  const shownAudits = audits.slice(0, limit);
  const hasMore = !showAll && audits.length > limit;

  if (badge) badge.textContent = audits.length + ' records';

  let html = '';

  shownAudits.forEach(audit => {
    const auditId = audit.id;
    const auditNo = audit.meta?.reportNo || auditId;

    // Find linked documents (now we limit the linked docs too)
    const linkedDocs = savedReports.filter(r => {
      if (r.templateKey === audit.templateKey) return false;
      const linkedAudit = r.meta?.linkedAudit || '';
      return linkedAudit === auditNo || linkedAudit === auditId;
    });

    // Sort linked docs by saved date (newest first)
    linkedDocs.sort((a, b) => {
      const dateA = new Date(a.savedAt || a.meta?.date || 0);
      const dateB = new Date(b.savedAt || b.meta?.date || 0);
      return dateB - dateA;
    });

    const checklists = linkedDocs.filter(r => r.templateKey && r.templateKey.startsWith('activity_'));
    const complianceReports = linkedDocs.filter(r => r.templateKey === 'compliance_report');
    const linkedCount = linkedDocs.length;

    // Parent row
    const statusBadge = badgeForStatus(audit.status || 'Draft');
    const dateStr = fmtDateTime(audit.savedAt || audit.meta?.auditDate || '');

    html += `
      <tr class="parent-audit-row" style="background:#f8faff; font-weight:600;">
        <td><b>${esc(auditNo)}</b></td>
        <td>${esc(audit.meta?.project || audit.titleLoc || '-')}</td>
        <td>${statusBadge}</td>
        <td>${esc(audit.meta?.auditor || '-')}</td>
        <td style="white-space:nowrap;">${dateStr}</td>
        <td>
          <span class="badge info">${linkedCount} linked</span>
          ${checklists.length ? `<span class="badge ok">📋 ${checklists.length}</span>` : ''}
          ${complianceReports.length ? `<span class="badge mid">📄 ${complianceReports.length}</span>` : ''}
        </td>
        <td><button class="btn btn-secondary" style="padding:4px 10px; font-size:11px;" onclick="openRecord('${audit.id}')">Open</button></td>
      </tr>
    `;

    // Child rows for linked documents (limit to 5 to keep DOM small)
    const linkedLimit = 5;
    const shownLinked = linkedDocs.slice(0, linkedLimit);
    const hasMoreLinked = linkedDocs.length > linkedLimit;

    if (shownLinked.length > 0) {
      shownLinked.forEach(doc => {
        const docStatus = badgeForStatus(doc.status || 'Draft');
        const docDate = fmtDateTime(doc.savedAt || doc.meta?.date || '');
        const docName = doc.templateName || doc.templateKey || 'Unknown';
        const docType = doc.templateKey?.startsWith('activity_') ? '📋 Checklist' :
                        doc.templateKey === 'compliance_report' ? '📄 Compliance Report' : '📎 Other';

        html += `
          <tr class="child-row" style="background:#f7fbfd;">
            <td style="padding-left:28px;">↳ ${esc(docName)}</td>
            <td>${esc(doc.meta?.project || doc.titleLoc || '-')}</td>
            <td>${docStatus}</td>
            <td>${esc(doc.preparedBy || '-')}</td>
            <td style="white-space:nowrap;">${docDate}</td>
            <td><span class="small">${docType}</span></td>
            <td><button class="btn btn-secondary" style="padding:4px 10px; font-size:11px;" onclick="openRecord('${doc.id}')">Open</button></td>
          </tr>
        `;
      });
      if (hasMoreLinked) {
        html += `
          <tr class="child-row" style="background:#f7fbfd;">
            <td colspan="7" style="padding-left:28px; color:#888; font-style:italic;">
              ... and ${linkedDocs.length - linkedLimit} more linked documents
            </td>
          </tr>
        `;
      }
    } else {
      html += `
        <tr class="child-row" style="background:#fafafa;">
          <td colspan="7" style="padding-left:28px; color:#888; font-style:italic;">No linked documents</td>
        </tr>
      `;
    }
  });

  // --- If there are more audits, add a "Load All" button ---
  if (hasMore) {
    html += `
      <tr>
        <td colspan="7" style="text-align:center; padding:12px;">
          <button class="btn btn-primary" onclick="loadAllAuditRecords()">
            📂 Load All (${audits.length - limit} more audits)
          </button>
        </td>
      </tr>
    `;
  }

  tbody.innerHTML = html;
}

function loadAllAuditRecords() {
  renderAuditRecords('auditRecordsBodyV2', 'auditRecordCountBadgeV2', true);
}

function renderAuditHistory() {
  updateAuditStats();
}
// ============================================================
// 23. PRINT FUNCTIONS
// ============================================================
function buildPrintableRecordHtml(record) {
  if (!record) return '';
  const t = templates[record.templateKey];
  if (!t) return '';
  let html = `<div class="print-block"><div class="sheet-shell print-sheet"><div class="sheet-head">`;
  html += `<div class="org">${esc(appConfig.companyName || 'QA/QC Suite')}</div>`;
  html += `<div class="dept">${esc(t.dept || '')}</div>`;
  html += `<div class="format">Format No. - ${esc(record.formatNo || '')}</div>`;
  html += `<div class="title">${esc(t.title)}</div></div>`;
  if (record.templateKey === 'ncr') {
    html += renderNCRExact(record);
    return html + '</div></div>';
  }
  if (record.templateKey === 'imir') {
    html += renderIMIRExact(record);
    return html + '</div></div>';
  }
  html += renderMetaRows(t.metaRows, record.meta || {});
  (t.sections || []).forEach((sec, si) => {
    const secData = (record.sections || [])[si] || {};
    if (sec.type === 'simple_check') html += renderSimpleCheck(sec, secData);
    else if (sec.type === 'checklist') html += renderChecklist(sec, secData);
    else if (sec.type === 'table') html += renderTable(sec, secData);
    else if (sec.type === 'accepted') html += renderAccepted(sec, secData);
    else if (sec.type === 'status') html += renderStatus(sec, secData, si + '_' + record.id);
    else if (sec.type === 'textarea') html += renderTextarea(sec, secData);
    else if (sec.type === 'signatures') html += renderSignatures(sec, secData);
    else if (sec.type === 'date') html += renderDate(sec, secData, sec.k);
    else if (sec.type === 'text') html += renderText(sec, secData);
  });
  return html + '</div></div>';
}
function printCurrentRecordWithChecklists() {
  const rec = currentRecord();
  if (!rec) { window.print(); return; }
  if (rec.templateKey !== 'rfi') {
    const pw = window.open('', '_blank');
    if (!pw) { toast('⚠️ Allow pop-up to print'); return; }
    pw.document.write(`<html><head><title>${esc(rec.templateName || 'Record')}</title>
      <style>body{font-family:Arial;padding:18px;} .sheet-head{text-align:center;border:1.8px solid #dbe4ee;border-bottom:none;padding:10px 8px;} .org{font-size:19px;font-weight:700;text-transform:uppercase;} .dept{font-size:16px;font-weight:700;} .format{font-size:13px;font-weight:700;} .title{font-size:20px;font-weight:700;text-transform:uppercase;} table{width:100%;border-collapse:collapse;} td,th{border:1px solid #dbe4ee;padding:6px 8px;font-size:13px;} th{background:#f3f3f3;} .label-cell{font-weight:700;background:#fafafa;width:18%;} input,select,textarea{border:none;background:transparent;width:100%;font-size:13px;outline:none;} textarea{min-height:40px;} .check-section-row td{background:#efefef!important;font-weight:700;text-transform:uppercase;} @page{margin:12mm;}
      </style></head><body>${buildPrintableRecordHtml(rec)}</body></html>`);
    pw.document.close(); pw.focus(); setTimeout(() => pw.print(), 250);
    return;
  }
  const rfiNo = rec.meta?.rfiNo || rec.id || '';
  const linkedChecklists = getLinkedChecklistsForRfi(rfiNo);
  const linkedNCRs = getLinkedNCRsForRfi(rfiNo);

  let combinedHtml = `<div style="font-family:Arial;padding:18px;background:#fff;">`;
  combinedHtml += `<h1 style="color:#123a66;font-size:22px;margin-bottom:12px;">RFI with Attached Documents</h1>`;
  combinedHtml += `<div style="margin-bottom:30px;page-break-after:avoid;">${buildPrintableRecordHtml(rec)}</div>`;

  if (linkedChecklists.length) {
    combinedHtml += `<div style="margin-top:20px;border-top:2px dashed #ccc;padding-top:20px;">`;
    combinedHtml += `<h2 style="color:#123a66;font-size:18px;">Linked Checklists</h2>`;
    linkedChecklists.forEach(chk => {
      combinedHtml += `<div style="margin-top:20px;page-break-after:avoid;">${buildPrintableRecordHtml(chk)}</div>`;
    });
    combinedHtml += `</div>`;
  }
  if (linkedNCRs.length) {
    combinedHtml += `<div style="margin-top:20px;border-top:2px dashed #ccc;padding-top:20px;">`;
    combinedHtml += `<h2 style="color:#123a66;font-size:18px;">Linked NCRs</h2>`;
    linkedNCRs.forEach(chk => {
      combinedHtml += `<div style="margin-top:20px;page-break-after:avoid;">${buildPrintableRecordHtml(chk)}</div>`;
    });
    combinedHtml += `</div>`;
  }
  combinedHtml += `</div>`;

  const pw = window.open('', '_blank');
  if (!pw) { toast('⚠️ Allow pop-up to print'); return; }
  pw.document.write(`<html><head><title>RFI with linked documents</title>
    <style>body{background:#fff;margin:0;padding:0;} .sheet-head{text-align:center;border:1.8px solid #dbe4ee;border-bottom:none;padding:10px 8px;} .org{font-size:19px;font-weight:700;text-transform:uppercase;} .dept{font-size:16px;font-weight:700;} .format{font-size:13px;font-weight:700;} .title{font-size:20px;font-weight:700;text-transform:uppercase;} table{width:100%;border-collapse:collapse;} td,th{border:1px solid #dbe4ee;padding:6px 8px;font-size:13px;} th{background:#f3f3f3;} .label-cell{font-weight:700;background:#fafafa;width:18%;} input,select,textarea{border:none;background:transparent;width:100%;font-size:13px;outline:none;} textarea{min-height:40px;} .check-section-row td{background:#efefef!important;font-weight:700;text-transform:uppercase;} @page{margin:12mm;} .exact-format .sheet-table, .exact-format table.exact-table{border:1.6px solid #000;} .exact-format .sheet-table td, .exact-format .sheet-table th, .exact-format table.exact-table td, .exact-format table.exact-table th{border:1px solid #000;}
    </style></head><body>${combinedHtml}</body></html>`);
  pw.document.close(); pw.focus(); setTimeout(() => pw.print(), 250);
}
function printFilteredHistory() {
  const rows = getHistoryFilteredRows();
  if (!rows.length) { toast('No records to print'); return; }
  const pw = window.open('', '_blank');
  if (!pw) { toast('Allow pop-up to print'); return; }
  let tableHtml = `<table><thead><tr><th>Date/Time</th><th>Format</th><th>Project</th><th>Prepared By</th><th>Status</th><th>Defects</th><th>Compliance</th></tr></thead><tbody>`;
  rows.forEach(r => {
    const scoreBadge = typeof r.score === 'number' ? `${r.score}%` : 'N/A';
    tableHtml += `<tr><td>${fmtDateTime(r.savedAt || r.meta?.date)}</td><td>${esc(r.templateName)}</td><td>${esc(r.titleLoc || '-')}</td><td>${esc(r.preparedBy || '-')}</td><td>${r.status || 'Draft'}</td><td>${r.defectsCount || 0}</td><td>${scoreBadge}</td></tr>`;
  });
  tableHtml += '</tbody></table>';
  pw.document.write(`<html><head><title>Saved Records</title><style>body{font-family:Arial;padding:20px;}table{width:100%;border-collapse:collapse;}th,td{border:1px solid #ccc;padding:8px;font-size:12px;}th{background:#f0f0f0;}@page{margin:12mm;}</style></head><body><h1>QA/QC Saved Records</h1><p>Generated: ${new Date().toLocaleString()}</p>${tableHtml}</body></html>`);
  pw.document.close(); pw.focus(); setTimeout(() => pw.print(), 250);
}

// ============================================================
// 24. DATA EXPORT / IMPORT
// ============================================================
function exportData() {
  const data = JSON.stringify(savedReports, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `QA_QC_Data_${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  toast('📤 Data exported');
}
function importData(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = JSON.parse(e.target.result);
      if (!Array.isArray(data)) throw new Error('Invalid format');
      savedReports = data;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(savedReports));
      toast('📥 Data imported locally (use Refresh to sync)');
      renderHistory(); updateStats();
    } catch (err) { toast('❌ Invalid file format'); }
  };
  reader.readAsText(file);
  event.target.value = '';
}
function exportAllDataJSON() {
  if (!(currentUser && currentUser.role === 'admin')) { toast('⛔ Admin only'); return; }
  const payload = { exportedAt: new Date().toISOString(), appConfig, masters, savedReports, notifications };
  const data = JSON.stringify(payload, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `QA_QC_Full_Backup_${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  toast('📤 Full backup exported');
}
function secureDeleteAllData() {
  if (!(currentUser && currentUser.role === 'admin')) { toast('⛔ Admin only'); return; }
  const phrase = prompt('Type DELETE ALL to confirm');
  if (phrase !== 'DELETE ALL') { toast('Cancelled'); return; }
  const pwd = prompt('Enter Admin password');
  if (pwd !== 'Admin123') { toast('Wrong password'); return; }
  if (!confirm('Final confirmation?')) return;
  savedReports = []; notifications = [];
  localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(NOTIFICATION_KEY);
  toast('🗑️ All data deleted (local)');
  renderHistory(); updateStats(); updateNotificationUI();
}
function syncWithCloud() {
  toast('☁️ Sync: Use Refresh button to load latest from server');
  document.getElementById('syncStatus').innerText = '💾 ' + (savedReports.length) + ' records';
}
function clearLocalCache() {
  if (!confirm('This will clear all locally cached data (reports, notifications). Your server data is safe. Continue?')) return;
  localStorage.removeItem('qaqc_suite_data_v2');
  localStorage.removeItem('qaqc_suite_notifications_v2');
  toast('🗑️ Cache cleared. Refreshing...');
  setTimeout(() => location.reload(), 500);
}

// ============================================================
// 25. INITIALIZATION
// ============================================================
async function init() {
  document.getElementById('todayDate').innerText = todayText();
  loadConfig(); loadMasters(); loadDb();
  applyConfig(); populateConfigForm(); populateMastersForm();
    // Register service worker for PWA
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
      .then(() => console.log('Service Worker registered successfully'))
      .catch(err => console.warn('Service Worker registration failed:', err));
  }

  const token = localStorage.getItem('token');
  if (token) {
    try {
      const user = JSON.parse(localStorage.getItem('user') || 'null');
      if (!user) {
        logout();
        return;
      }
      currentUser = user;

      document.querySelectorAll('.auth-only').forEach(el => el.classList.remove('hidden'));
      await loadFromServer();
      renderCards();
      updateStats();
      updateNotificationUI();
      startNotificationPolling();
      applyFiltersAndRefresh();
      switchView('dashboard');
      setActiveKpiCard('total');
      const unread = notifications.filter(n => n.recipient_username === user.username && !n.read).length;
      if (unread > 0) toast('🔔 You have ' + unread + ' unread notification' + (unread > 1 ? 's' : ''));
    } catch (e) {
      console.warn('Auto-login failed, logging out', e);
      logout();
    }
  } else {
    document.querySelectorAll('.auth-only').forEach(el => el.classList.add('hidden'));
    switchView('login');
  }
}

document.addEventListener('DOMContentLoaded', init);
document.addEventListener('change', e => {
  if (e.target.matches('.status-select')) {
    stylizeStatus(e.target);
    updateProgress();
  }
  // Immediate filter for select changes on history page
  if (e.target.closest('.history-wrap') && e.target.matches('select')) {
    applyFiltersAndRefresh();
  }
});

// Debounced filter for history page inputs
const debouncedFilter = debounce(() => {
  applyFiltersAndRefresh();
}, 300);

document.addEventListener('input', e => {
  // Update progress for form inputs
  if (e.target.matches('.table-textarea,.plain-textarea,.value-input,.table-input,.sig-input')) {
    updateProgress();
  }
  // Debounced filter for history page inputs
  if (e.target.closest('.history-wrap') && 
      (e.target.matches('input') || e.target.matches('select'))) {
    debouncedFilter();
  }
});
// ADD THIS ↓↓↓
document.addEventListener('DOMContentLoaded', function() {
  const regForm = document.getElementById('registerForm');
  if (regForm) {
    regForm.addEventListener('submit', registerUser);
  }
});
// ↑↑↑ ADD THIS
// ---- NOTIFICATION DROPDOWN CLOSE ----
document.addEventListener('click', function(e) {
  const container = document.getElementById('notifContainer');
  if (container && !container.contains(e.target)) {
    document.getElementById('notifDropdown').classList.remove('open');
  }
});

// ===== CLOSE SIDEBAR WHEN CLICKING OUTSIDE =====
document.addEventListener('click', function(e) {
  const sidebar = document.querySelector('.sidebar');
  const hamburger = document.getElementById('hamburgerBtn');
  if (sidebar && sidebar.classList.contains('open') && 
      !sidebar.contains(e.target) && 
      !hamburger.contains(e.target)) {
    sidebar.classList.remove('open');
  }
});
// User mapping for notification routing (matches backend seeds)
const users = [
  { u: 'admin', role: 'admin', name: 'System Admin', assigned_sites: ['*'] },
  { u: 'exec_siteA', role: 'exec_engineer', name: 'Execution Engineer Site A', assigned_sites: ['Site-A'] },
  { u: 'exec_siteB', role: 'exec_engineer', name: 'Execution Engineer Site B', assigned_sites: ['Site-B'] },
  { u: 'qa_siteA', role: 'qa_head', name: 'QA Head Site A', assigned_sites: ['Site-A'] },
  { u: 'qa_siteB', role: 'qa_head', name: 'QA Head Site B', assigned_sites: ['Site-B'] },
  { u: 'contractor1_siteA', role: 'engineer', name: 'Contractor 1 - Site A', assigned_sites: ['Site-A'] },
  { u: 'contractor2_siteA', role: 'engineer', name: 'Contractor 2 - Site A', assigned_sites: ['Site-A'] },
  { u: 'contractor1_siteB', role: 'engineer', name: 'Contractor 1 - Site B', assigned_sites: ['Site-B'] },
  { u: 'manager', role: 'manager', name: 'Project Manager', assigned_sites: ['*'] },
  { u: 'consultant', role: 'consultant', name: 'Consultant', assigned_sites: ['*'] }
];
// DARK MODE TOGGLE
const darkModeToggle = document.getElementById('darkModeToggle');
const DARK_MODE_KEY = 'qaqc_dark_mode';

// Load saved preference
if (localStorage.getItem(DARK_MODE_KEY) === 'true') {
    document.body.classList.add('dark-mode');
    if (darkModeToggle) darkModeToggle.textContent = '☀️';
}

// Toggle on click
if (darkModeToggle) {
    darkModeToggle.addEventListener('click', function() {
        document.body.classList.toggle('dark-mode');
        const isDark = document.body.classList.contains('dark-mode');
        localStorage.setItem(DARK_MODE_KEY, isDark);
        darkModeToggle.textContent = isDark ? '☀️' : '🌙';
    });
}
}
