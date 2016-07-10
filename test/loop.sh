#!/bin/sh
while true; do
	curl -H "Content-Type: application/json" -X POST -d '{"serviceID":"urn:twitter-com:serviceID:Statuses","actionName":"retweetStatus","argumentList":{"id":24,"options":{},"retweetStatus":{}}}' http://localhost:3049/device-control/cad9fc57-e436-4a0a-a71b-cd8647a4a396/invoke-action &
	sleep 1
done

