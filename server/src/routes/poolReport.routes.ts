import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  listGunnyBags, createGunnyBag, deleteGunnyBag,
  listElectricityBills, createElectricityBill, deleteElectricityBill,
  listMaintenanceExpenses, createMaintenanceExpense, deleteMaintenanceExpense,
  listMiscExpenses, createMiscExpense, deleteMiscExpense,
  listDrawings, createDrawing, deleteDrawing,
  listInterestCharges, createInterestCharge, deleteInterestCharge,
  listTermLoanPrincipals, createTermLoanPrincipal, deleteTermLoanPrincipal,
  listStorageMaintenance, createStorageMaintenance, deleteStorageMaintenance,
} from '../controllers/poolReport.controller.js';

const router = Router();

router.get('/gunny-bags', asyncHandler(listGunnyBags));
router.post('/gunny-bags', asyncHandler(createGunnyBag));
router.delete('/gunny-bags/:id', asyncHandler(deleteGunnyBag));

router.get('/electricity-bills', asyncHandler(listElectricityBills));
router.post('/electricity-bills', asyncHandler(createElectricityBill));
router.delete('/electricity-bills/:id', asyncHandler(deleteElectricityBill));

router.get('/maintenance-expenses', asyncHandler(listMaintenanceExpenses));
router.post('/maintenance-expenses', asyncHandler(createMaintenanceExpense));
router.delete('/maintenance-expenses/:id', asyncHandler(deleteMaintenanceExpense));

router.get('/misc-expenses', asyncHandler(listMiscExpenses));
router.post('/misc-expenses', asyncHandler(createMiscExpense));
router.delete('/misc-expenses/:id', asyncHandler(deleteMiscExpense));

router.get('/drawings', asyncHandler(listDrawings));
router.post('/drawings', asyncHandler(createDrawing));
router.delete('/drawings/:id', asyncHandler(deleteDrawing));

router.get('/interest-charges', asyncHandler(listInterestCharges));
router.post('/interest-charges', asyncHandler(createInterestCharge));
router.delete('/interest-charges/:id', asyncHandler(deleteInterestCharge));

router.get('/term-loan-principals', asyncHandler(listTermLoanPrincipals));
router.post('/term-loan-principals', asyncHandler(createTermLoanPrincipal));
router.delete('/term-loan-principals/:id', asyncHandler(deleteTermLoanPrincipal));

router.get('/storage-maintenance', asyncHandler(listStorageMaintenance));
router.post('/storage-maintenance', asyncHandler(createStorageMaintenance));
router.delete('/storage-maintenance/:id', asyncHandler(deleteStorageMaintenance));

export default router;
