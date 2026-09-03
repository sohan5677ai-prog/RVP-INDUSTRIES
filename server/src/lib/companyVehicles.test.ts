import { describe, expect, it } from 'vitest';
import {
  companyVehicleNumbers,
  findCompanyVehicle,
  isVehicleExempt,
  parseCompanyVehicles,
} from './calc.js';

// The KNM vehicle directory lives in one CompanyProfile string column, so the
// driver columns had to be added without breaking rows saved before they
// existed - and without breaking the exemption check, which zeroes kata and the
// hamali lorry-share and therefore moves money.
describe('company vehicle directory', () => {
  it('reads rows saved before the driver columns existed', () => {
    expect(parseCompanyVehicles('AP39UX9105\nTN28BF7423')).toEqual([
      { number: 'AP39UX9105', driverName: '', driverPhone: '', religion: null },
      { number: 'TN28BF7423', driverName: '', driverPhone: '', religion: null },
    ]);
  });

  it('reads the older comma-separated form', () => {
    expect(companyVehicleNumbers('AP39UX9105, TN28BF7423')).toEqual(['ap39ux9105', 'tn28bf7423']);
  });

  it('reads number, driver name and phone off a row', () => {
    expect(parseCompanyVehicles('AP39UX9105|Ravi Kumar|9876543210')).toEqual([
      { number: 'AP39UX9105', driverName: 'Ravi Kumar', driverPhone: '9876543210', religion: null },
    ]);
  });

  it('reads number, driver name, phone, and community tag', () => {
    expect(parseCompanyVehicles('AP39UX9105|Nagaraja|8919412955|HINDU\nAP39UX9108|Vijay|9182405899|MUSLIM')).toEqual([
      { number: 'AP39UX9105', driverName: 'Nagaraja', driverPhone: '8919412955', religion: 'HINDU' },
      { number: 'AP39UX9108', driverName: 'Vijay', driverPhone: '9182405899', religion: 'MUSLIM' },
    ]);
  });

  it('reads a phone recorded without a name', () => {
    expect(parseCompanyVehicles('AP39UX9105||9876543210')).toEqual([
      { number: 'AP39UX9105', driverName: '', driverPhone: '9876543210', religion: null },
    ]);
  });

  it('mixes legacy and driver rows, and ignores blank lines', () => {
    expect(companyVehicleNumbers('AP39UX9105|Ravi|9876543210\n\nTN28BF7423\n')).toEqual([
      'ap39ux9105',
      'tn28bf7423',
    ]);
  });

  it('keeps exempting a vehicle once a driver is added to its row', () => {
    expect(isVehicleExempt('AP39UX9105', 'AP39UX9105|Ravi|9876543210')).toBe(true);
    expect(isVehicleExempt('ap39ux9105', 'AP39UX9105|Ravi|9876543210')).toBe(true);
  });

  it('never exempts a lorry on the strength of the driver columns alone', () => {
    expect(isVehicleExempt('Ravi', 'AP39UX9105|Ravi|9876543210')).toBe(false);
    expect(isVehicleExempt('9876543210', 'AP39UX9105|Ravi|9876543210')).toBe(false);
  });

  it('looks a driver up despite spaces and hyphens in the typed number', () => {
    const list = 'AP39UX9105|Ravi Kumar|9876543210';
    expect(findCompanyVehicle('AP 39 UX 9105', list)?.driverName).toBe('Ravi Kumar');
    expect(findCompanyVehicle('ap-39-ux-9105', list)?.driverPhone).toBe('9876543210');
  });

  it('finds nothing for a hired lorry, or when the directory is empty', () => {
    expect(findCompanyVehicle('KA05MN1234', 'AP39UX9105|Ravi|9876543210')).toBeNull();
    expect(findCompanyVehicle('AP39UX9105', null)).toBeNull();
    expect(findCompanyVehicle('', 'AP39UX9105|Ravi|9876543210')).toBeNull();
  });
});
