import { prisma } from './src/lib/prisma.js';

async function testAuth() {
  try {
    const company = await prisma.companyProfile.findUnique({ where: { id: 'default' } });
    console.log("User:", company?.taxproGstUser);
    
    const response = await fetch('http://gstsandbox.charteredinfo.com/api/v1.03/auth', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'client_id': company?.taxproGspId || '',
        'client_secret': company?.taxproGspSecret || '',
      },
      body: JSON.stringify({
        UserName: company?.taxproGstUser || '',
        Password: company?.taxproGstPass || '',
      }),
    });
    
    console.log("Status:", response.status);
    const text = await response.text();
    console.log("Body:", text);
    
  } catch (e) {
    console.error(e);
  } finally {
    await prisma.$disconnect();
  }
}

testAuth();
