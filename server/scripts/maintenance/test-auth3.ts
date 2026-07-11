import { prisma } from './src/lib/prisma.js';
async function testAuth() { 
    try { 
        const company = await prisma.companyProfile.findUnique({ where: { id: 'default' } }); 
        console.log('User:', company?.taxproGstUser); 
        const response = await fetch('http://gstsandbox.charteredinfo.com/api/v1.03/auth', { 
            method: 'POST', 
            headers: { 
                'Content-Type': 'application/json', 
                'client_id': 'test', 
                'client_secret': 'test', 
                'aspid': 'test',
                'password': 'test',
                'asp_secret': 'test'
            }, 
            body: JSON.stringify({ 
                UserName: company?.taxproGstUser || '', 
                Password: company?.taxproGstPass || '', 
            }), 
        }); 
        console.log('Status:', response.status); 
        console.log('Body:', await response.text()); 
    } catch (e) { 
        console.error(e); 
    } finally { 
        await prisma.$disconnect(); 
    } 
} 
testAuth();
