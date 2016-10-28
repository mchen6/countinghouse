#!/bin/sh
while true; do
	curl -H "Content-Type: application/json" -X POST -d '{"serviceID":"urn:apemesh-com:serviceID:db-request","actionName":"request","argumentList":{"input":{"db": "devices"}}}' http://localhost:3049/devices/3a509370-6db9-5fd0-9e98-4a912810d805/invoke-action&
	sleep 1
done

#curl -H "Content-Type: application/json" -X POST -d '{"serviceID":"urn:weibo-com:serviceID:Statuses","actionName":"getFriendsTimeline","argumentList":{"input":{"count": 10}}}' http://localhost:3049/devices/8014e6d8-0880-5d72-9ad2-b8703811098e/invoke-action
#curl -H "Content-Type: application/json" -X POST -d '{"registry":"http://121.43.107.95:5984/", "name":"cdif-qunar-train-service", "version":"0.0.5"}' http://121.43.107.95:3049/module-install
