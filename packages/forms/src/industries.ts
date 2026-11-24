/**
 * The forms InkStat knows about, by industry: the ones with a built-in template
 * ("ready") and public forms that don't have one yet ("planned"), which a user
 * can build a template for from a photo. Sources are the agencies that publish
 * the blank forms.
 */

export interface KnownForm {
  name: string;
  /** Who publishes it, e.g. "Rhode Island DOT". */
  publisher: string;
  /** What's on it, in a line. */
  summary: string;
  /** The built-in template's id, when there is one. */
  templateId?: string;
  /** Where the blank form can be downloaded. */
  source?: string;
}

export interface Industry {
  id: string;
  name: string;
  /** Who fills these forms in, and why they're retyped. */
  description: string;
  forms: KnownForm[];
}

export const INDUSTRIES: Industry[] = [
  {
    id: 'construction-testing',
    name: 'Construction materials testing',
    description: 'Field technicians test soil and concrete on site; the sheets are retyped into lab reports.',
    forms: [
      {
        name: 'Nuclear Density Test of Soils (TF2)',
        publisher: 'Rhode Island DOT',
        summary: 'Section details, then up to four compaction tests with the form’s own formulas.',
        templateId: 'ridot-tf2',
        source: 'https://www.dot.ri.gov/documents/doingbusiness/materials/fieldforms/Field/301%20-%20TF2%20-%20Nuclear%20Density%20Test%20of%20Soils%20Report.pdf',
      },
      {
        name: 'Structural Concrete Tests (03-22-0740)',
        publisher: 'Louisiana DOTD',
        summary: 'Slump, air content and cylinder breaks: load, area and strength for two batches.',
        templateId: 'la-dotd-0740',
        source: 'https://dotd.la.gov/media/1b3gzfw1/form-03-22-0740-structural-concrete-test.pdf',
      },
      {
        name: 'Concrete Cylinders Test Data (DT1308)',
        publisher: 'Wisconsin DOT',
        summary: 'Four cylinder cards per page: mix, slump, air, temperatures.',
        source: 'https://www.wisconsindot.gov/Documents/formdocs/dt1308.pdf',
      },
    ],
  },
  {
    id: 'food-safety',
    name: 'Food safety',
    description: 'Kitchens log cooling and holding temperatures by hand for the health inspector.',
    forms: [
      {
        name: 'Cooling Log',
        publisher: 'Minnesota Dept. of Health',
        summary: 'Time and temperature each hour while food cools: 70°F by 2 hours, 41°F by 6.',
        templateId: 'mn-cooling-log',
        source: 'https://www.health.mn.gov/communities/environment/food/docs/fs/coolinglog.pdf',
      },
      {
        name: 'HACCP Cook and Cooling Temperature Log',
        publisher: 'Multnomah County, OR',
        summary: 'Final cook temperature, then cooling readings and corrective actions.',
        source: 'https://multco.us/file/54803/download',
      },
    ],
  },
  {
    id: 'backflow',
    name: 'Plumbing: backflow testing',
    description: 'Certified testers test backflow preventers every year; each city has its own report form.',
    forms: [
      {
        name: 'Backflow Prevention Assembly Test Report',
        publisher: 'City of Phoenix',
        summary: 'Assembly serial and size, check valve pressures, pass/fail, tester and gauge.',
        source: 'https://www.phoenix.gov/content/dam/phoenix/pddsite/documents/trt/external/dsd_trt_pdf_00337.pdf',
      },
      {
        name: 'Backflow Preventer Inspection and Field Test Report',
        publisher: 'Seattle Public Utilities',
        summary: 'DCVA, RPBA and PVBA results side by side, repairs and final test.',
        source: 'https://seattle.gov/documents/Departments/SPU/Services/Water/SPU_Backflow-Preventer-Inspection-Field-Test-Report_2023.pdf',
      },
      {
        name: 'Backflow Prevention Assembly Test and Maintenance Report',
        publisher: 'City of Dallas',
        summary: 'Assembly type, initial test and test after repair, gauge calibration.',
        source: 'https://dallascityhall.com/departments/sustainabledevelopment/DCH%20documents/pdf/building/BackflowTestReport.pdf',
      },
      {
        name: 'Backflow Assembly Test and Maintenance Report',
        publisher: 'City of Longmont',
        summary: 'Account, assembly, initial test, repairs and retest.',
        source: 'https://longmontcolorado.gov/wp-content/uploads/2024/07/Downloadable-Backflow-Test-Form-2022.pdf',
      },
    ],
  },
  {
    id: 'healthcare',
    name: 'Clinics and pharmacies',
    description: 'Vaccine storage temperatures are logged twice a day on paper for public vaccine programs.',
    forms: [
      {
        name: 'Temperature Log for Refrigerator (Fahrenheit)',
        publisher: 'Immunize.org',
        summary: 'Min and max temperatures for each day, with the 36–46°F safe range printed.',
        source: 'https://www.immunize.org/wp-content/uploads/catg.d/p3037f.pdf',
      },
    ],
  },
];
