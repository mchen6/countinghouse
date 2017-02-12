#!/usr/local/bin/python
# coding: utf-8
import urllib2
import json

# 这里展示的是发送短信验证码API的input JSON对象的构建方法
# 其他API的input JSON对象参数的构建方法请参照各自的API文档
inputData = json.dumps({
  "serviceID":"urn:cdif-io:serviceID:短信服务",
  "actionName":"发送验证码",
  "input": {
    "phoneNum":"13910001000",
    "templateID":"<模板ID>",
    "content":["211315"]
  }
})

headers = {'Content-type': 'application/json', 'X-Apemesh-Key': '<用户appKey>'}
url = "https://api.apemesh.com:3049/devices/f5dc73f9-b739-5ee2-add7-e499da04c6ec/invoke-action"

try:
  req = urllib2.Request(url, inputData, headers)
  f = urllib2.urlopen(req)
  response = json.loads(f.read())
  print response['output']['result']
except urllib2.HTTPError, e:
  err = json.loads(e.read())
  print err['fault']['reason']
