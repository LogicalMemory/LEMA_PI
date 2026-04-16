# Setup the captive portal
sudo apt update && sudo apt upgrade -y
sudo apt install -y network-manager

sudo nmcli device wifi hotspot ssid scraper-pi password lemascraper123 ifname wlan0

echo "[device-wifi-no-scan-mac-rand]
wifi.scan-rand-mac-address=no" > /etc/NetworkManager/conf.d/99-wifi.conf

sudo nmcli con modify Hotspot 802-11-wireless-security.pmf 1

sudo nmcli device wifi hotspot ssid scraper-pi password lemascraper123 ifname wlan0

sudo nmcli connection modify <hotspot UUID> connection.autoconnect yes connection.autoconnect-priority 100

sudo apt install python3-flask -y

# Setup the scraper service

chmod -R +x /home/servers/projects/LEMA_PI
npm i playwright
npx playwright install chromium

"[Unit]
Description=Lema Scraper Service
After=network.target

[Service]
WorkingDirectory=/home/servers/projects/LEMA_PI
ExecStart=/usr/bin/python3 /home/servers/projects/LEMA_PI/app.py
Restart=always

[Install]
WantedBy=multi-user.target
" > /etc/systemd/system/lema_scraper.service
sudo systemctl start lema_scraper
sudo systemctl status lema_scraper
sudo systemctl enable lema_scraper

# get the github stuff so we can run the server


# setup captive portal
sudo apt install net-tools -y

#uncomment
sudo nano /etc/sysctl.conf
net.ipv4.ip_forward=1

#cmds

sudo iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE  
sudo iptables -A FORWARD -i eth0 -o wlan0 -m state --state RELATED,ESTABLISHED -j ACCEPT
sudo iptables -A FORWARD -i wlan0 -o eth0 -j ACCEPT  

sudo sh -c "iptables-save > /etc/iptables.ipv4.nat"  


sudo apt install git libmicrohttpd-dev -y

sudo apt install libjson-c-dev -y

git clone https://github.com/nodogsplash/nodogsplash.git
cd nodogsplash
make
sudo make install

sudo nano /etc/nodogsplash/nodogsplash.conf  
"GatewayInterface wlan0
GatewayAddress 192.168.5.1
MaxClients 250
AuthIdleTimeout 480
"

sudo echo "nodogsplash
iptables-restore < /etc/iptables.ipv4.nat" >> /etc/rc.local



#CI/CD setup

chmod +x update.sh