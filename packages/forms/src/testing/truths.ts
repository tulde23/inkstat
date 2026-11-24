import type { Truth } from './oracle';

/**
 * Made-up filled-in copies of the built-in forms, written as a person would
 * (dates as 10/14/26, times as 9:40, cells as "3:20/68"). The numbers follow
 * each form's own arithmetic, except where a real problem is planted:
 * - soil test 3 is below the 95% specification;
 * - the rice in the cooling log is 72°F at 2 hours (the limit is 70).
 */
export const TRUTHS: Record<string, Truth> = {
  'ridot-tf2': {
    fields: {
      itemNo: '203.0300',
      date: '10/14/26',
      contractNo: '2026-CH-0417',
      ptsid: '44812',
      fapNo: 'STP-0117(021)',
      project: 'Route 117 Reconstruction',
      location: 'Warwick',
      gaugeNo: '3440-31877',
      stdDensity: '2781',
      stdMoisture: '684',
      testType: 'Acceptance',
      soil: 'Gravel borrow',
      labNo: 'S-26-118',
      A: '118.5',
      optMoisture: '11.2',
      sectionBegin: '10+00',
      sectionEnd: '22+00',
      B: '1200',
      C: '24',
      D: '28800',
      E: '0.67',
      F: '4',
      G: '3',
      H: '400',
      spec: 'Does Not Meet Spec',
      remarks: 'Test 3 retest after rolling',
      technician: 'D. Medeiros',
    },
    tables: {
      tests: [
        { I: '10+00', J: '0.4521', K: '180.84', L: '11+81', M: '24', N: '0.3127', P: '7.50', offset: '4 Rt', elevation: '102.3', probeDepth: '8', moisture: '9.8', wetDensity: '125.6', Q: '114.4', R: '96.5', specification: '95' },
        { I: '14+00', J: '0.7310', K: '292.4', L: '16+92', M: '24', N: '0.6612', P: '15.87', offset: '9 Lt', elevation: '101.8', probeDepth: '8', moisture: '10.4', wetDensity: '128.1', Q: '116.0', R: '97.9', specification: '95' },
        { I: '18+00', J: '0.1984', K: '79.4', L: '18+79', M: '24', N: '0.9045', P: '21.71', offset: '2 Rt', elevation: '101.1', probeDepth: '8', moisture: '12.9', wetDensity: '122.0', Q: '108.1', R: '91.2', specification: '95' },
      ],
    },
  },

  'la-dotd-0740': {
    fields: {
      projectNo: 'H.004521',
      materialCode: '1102',
      lotNo: 'L-26-118',
      dateSampled: '10/14/26',
      submittedBy: 'R. Landry',
      quantity: '42 CY',
      purposeCode: '3',
      plantCode: 'P-117',
      mixDesign: 'MD-4410',
      dateReceived: '10/15/26',
      itemNo: 'S-005 Bridge deck pour 2',
      madeBy: 'K. Thibodeaux',
      testedForAcceptanceBy: 'M. Guidry',
      batch1No: 'B-0612',
      batch1DateTested: '11/11/26',
      batch1Slump: '3.5',
      batch1Air: '4.8',
      batch1TimeMade: '9:40',
      batch1Avg: '4883',
      batch2No: 'B-0613',
      batch2DateTested: '11/11/26',
      batch2Slump: '4',
      batch2Air: '5.1',
      batch2TimeMade: '11:15',
      batch2Avg: '4956',
      lotAvg: '4920',
      testedBy: 'A. Broussard',
      checkedBy: 'J. Hebert',
      pay: '100',
      remarks: 'B3 low break, honeycombing at top',
      approvedBy: 'T. Fontenot',
    },
    tables: {
      cylinders1: [
        { sampleNo: 'A1', labNo: '26-30411', condition: '1', breakCode: '2', age: '28', diameter: '4', area: '12.57', maxLoad: '61,250', strength: '4873' },
        { sampleNo: 'A2', labNo: '26-30412', condition: '1', breakCode: '2', age: '28', diameter: '4', area: '12.57', maxLoad: '63,100', strength: '5020' },
        { sampleNo: 'A3', labNo: '26-30413', condition: '1', breakCode: '3', age: '28', diameter: '4', area: '12.57', maxLoad: '59,800', strength: '4757' },
      ],
      cylinders2: [
        { sampleNo: 'B1', labNo: '26-30414', condition: '1', breakCode: '1', age: '28', diameter: '6', area: '28.27', maxLoad: '141,300', strength: '4998' },
        { sampleNo: 'B2', labNo: '26-30415', condition: '1', breakCode: '2', age: '28', diameter: '6', area: '28.27', maxLoad: '138,900', strength: '4913' },
        { sampleNo: 'B3', labNo: '26-30416', condition: '2', breakCode: '5', age: '28', diameter: '6', area: '28.27', maxLoad: '120,400', strength: '4259', notUsed: true },
      ],
    },
  },

  'mn-cooling-log': {
    fields: {
      verifiedBy: 'MR',
      verifiedDate: '11/20/26',
      correctiveActions: 'Rice 72F at 2 hrs - moved to ice bath',
    },
    tables: {
      cooling: [
        { food: 'Chili', date: '11/20/26', start: '1:30/135', h1: '2:30/102', h2: '3:20/68', h3: '4:15/56', h4: '5:10/47', h5: '6:05/42', h6: '7:00/39', monitoredBy: 'AK' },
        { food: 'Rice', date: '11/20/26', start: '7:00/140', h1: '7:55/104', h2: '8:50/72', h3: '9:45/60', h4: '10:40/50', h5: '11:30/44', h6: '12:20/40', monitoredBy: 'AK' },
        { food: 'Turkey stock', date: '11/20/26', start: '2:00/150', h1: '2:50/110', h2: '3:40/69', h3: '4:30/58', h4: '5:20/48', h5: '6:10/41', monitoredBy: 'MR' },
      ],
    },
  },
};
