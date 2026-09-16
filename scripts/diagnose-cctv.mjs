import net from 'net';
import http from 'http';

function checkPort(ip, port, timeout = 700) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeout);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, ip);
  });
}

async function main() {
  console.log('=== CCTV Network Diagnostic ===');

  // Check hardcoded IPs
  console.log('\n1. Checking default hardcoded IPs (192.168.1.101 & 192.168.1.102):');
  for (const ip of ['192.168.1.101', '192.168.1.102', '192.168.1.1']) {
    const port80 = await checkPort(ip, 80, 1000);
    const port554 = await checkPort(ip, 554, 1000);
    console.log(`- ${ip}: Port 80=${port80}, Port 554(RTSP)=${port554}`);
  }

  // Check known dynamic devices from ARP
  console.log('\n2. Checking 10.185.145.157:');
  for (const port of [80, 554, 37777, 8000, 8080]) {
    const open = await checkPort('10.185.145.157', port, 800);
    console.log(`- 10.185.145.157 Port ${port}: ${open}`);
  }

  // Sweep 10.185.145.x
  console.log('\n3. Scanning current Wi-Fi subnet (10.185.145.1 - 254) for open CCTV ports (80, 554, 37777)...');
  const found = [];
  const promises = [];
  for (let i = 1; i <= 254; i++) {
    const ip = `10.185.145.${i}`;
    promises.push(
      (async () => {
        const p80 = await checkPort(ip, 80, 800);
        const p554 = await checkPort(ip, 554, 800);
        const p37777 = await checkPort(ip, 37777, 800);
        if (p80 || p554 || p37777) {
          found.push({ ip, p80, p554, p37777 });
        }
      })()
    );
  }
  await Promise.all(promises);

  console.log('\nSubnet scan results:');
  if (found.length === 0) {
    console.log('No devices found responding on ports 80, 554, or 37777 on subnet 10.185.145.0/24');
  } else {
    for (const f of found) {
      console.log(`Found device: ${f.ip} -> HTTP(80): ${f.p80}, RTSP(554): ${f.p554}, Dahua/CPPlus(37777): ${f.p37777}`);
    }
  }

  // Also check if any other subnets like 192.168.0.x or 192.168.1.x respond to anything
  console.log('\nDone.');
  process.exit(0);
}

main();
