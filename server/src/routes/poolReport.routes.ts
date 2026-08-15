import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  listGunnyBags, createGunnyBag, updateGunnyBag, deleteGunnyBag,
  listElectricityBills, createElectricityBill, updateElectricityBill, deleteElectricityBill,
  listMaintenanceExpenses, createMaintenanceExpense, updateMaintenanceExpense, deleteMaintenanceExpense,
  listMiscExpenses, createMiscExpense, updateMiscExpense, deleteMiscExpense,
  listDrawings, createDrawing, updateDrawing, deleteDrawing,
  listInterestCharges, createInterestCharge, updateInterestCharge, deleteInterestCharge,
  listTermLoanPrincipals, createTermLoanPrincipal, updateTermLoanPrincipal, deleteTermLoanPrincipal,
  listStorageMaintenance, createStorageMaintenance, updateStorageMaintenance, deleteStorageMaintenance,
  listOtherIncome, createOtherIncome, updateOtherIncome, deleteOtherIncome,
  listGunnySales, createGunnySale, updateGunnySale, deleteGunnySale,
  listSubscriptionCharges, createSubscriptionCharge, updateSubscriptionCharge, deleteSubscriptionCharge,
  listSubscriptionPlans, updateSubscriptionPlan,
} from '../controllers/poolReport.controller.js';

const router = Router();

router.get('/gunny-bags', asyncHandler(listGunnyBags));
router.post('/gunny-bags', asyncHandler(createGunnyBag));
router.put('/gunny-bags/:id', asyncHandler(updateGunnyBag));
router.delete('/gunny-bags/:id', asyncHandler(deleteGunnyBag));

router.get('/gunny-sales', asyncHandler(listGunnySales));
router.post('/gunny-sales', asyncHandler(createGunnySale));
router.put('/gunny-sales/:id', asyncHandler(updateGunnySale));
router.delete('/gunny-sales/:id', asyncHandler(deleteGunnySale));


router.get('/electricity-bills', asyncHandler(listElectricityBills));
router.post('/electricity-bills', asyncHandler(createElectricityBill));
router.put('/electricity-bills/:id', asyncHandler(updateElectricityBill));
router.delete('/electricity-bills/:id', asyncHandler(deleteElectricityBill));

router.get('/maintenance-expenses', asyncHandler(listMaintenanceExpenses));
router.post('/maintenance-expenses', asyncHandler(createMaintenanceExpense));
router.put('/maintenance-expenses/:id', asyncHandler(updateMaintenanceExpense));
router.delete('/maintenance-expenses/:id', asyncHandler(deleteMaintenanceExpense));

router.get('/misc-expenses', asyncHandler(listMiscExpenses));
router.post('/misc-expenses', asyncHandler(createMiscExpense));
router.put('/misc-expenses/:id', asyncHandler(updateMiscExpense));
router.delete('/misc-expenses/:id', asyncHandler(deleteMiscExpense));

router.get('/drawings', asyncHandler(listDrawings));
router.post('/drawings', asyncHandler(createDrawing));
router.put('/drawings/:id', asyncHandler(updateDrawing));
router.delete('/drawings/:id', asyncHandler(deleteDrawing));

router.get('/interest-charges', asyncHandler(listInterestCharges));
router.post('/interest-charges', asyncHandler(createInterestCharge));
router.put('/interest-charges/:id', asyncHandler(updateInterestCharge));
router.delete('/interest-charges/:id', asyncHandler(deleteInterestCharge));

router.get('/term-loan-principals', asyncHandler(listTermLoanPrincipals));
router.post('/term-loan-principals', asyncHandler(createTermLoanPrincipal));
router.put('/term-loan-principals/:id', asyncHandler(updateTermLoanPrincipal));
router.delete('/term-loan-principals/:id', asyncHandler(deleteTermLoanPrincipal));

router.get('/storage-maintenance', asyncHandler(listStorageMaintenance));
router.post('/storage-maintenance', asyncHandler(createStorageMaintenance));
router.put('/storage-maintenance/:id', asyncHandler(updateStorageMaintenance));
router.delete('/storage-maintenance/:id', asyncHandler(deleteStorageMaintenance));

router.get('/subscription-charges', asyncHandler(listSubscriptionCharges));
router.post('/subscription-charges', asyncHandler(createSubscriptionCharge));
router.put('/subscription-charges/:id', asyncHandler(updateSubscriptionCharge));
router.delete('/subscription-charges/:id', asyncHandler(deleteSubscriptionCharge));

router.get('/subscription-plans', asyncHandler(listSubscriptionPlans));
router.patch('/subscription-plans/:id', asyncHandler(updateSubscriptionPlan));

router.get('/other-income', asyncHandler(listOtherIncome));
router.post('/other-income', asyncHandler(createOtherIncome));
router.put('/other-income/:id', asyncHandler(updateOtherIncome));
router.delete('/other-income/:id', asyncHandler(deleteOtherIncome));

export default router;
