package main

import (
  "bytes"
  "io/ioutil"
  "net/http"
  "encoding/json"
  "fmt"
)

// 这里展示的是发送短信验证码API的input JSON对象的构建方法
// 其他API的input JSON对象参数的构建方法请参照各自的API文档

type RequestData struct {
  ServiceID              string     `json:"serviceID"`
  ActionName             string     `json:"actionName"`
  InputData              Input     `json:"input"`
}

type Input struct {
  PhoneNum    string `json:"phoneNum"`
  TemplateID  string `json:"templateID"`
  Content  ContentData `json:"content"`
}

type ContentData []string

func main() {
 var url = "https://api.apemesh.com:3049/devices/f5dc73f9-b739-5ee2-add7-e499da04c6ec/invoke-action"

  var data = RequestData {
    ServiceID: "urn:cdif-io:serviceID:短信服务",
    ActionName: "发送验证码",
    InputData: Input{"1391000000", "<模板ID>", []string{"123135"}},
  }
  body, err := json.Marshal(data)

  if err != nil {
    panic(err)
  }

  req, err := http.NewRequest("POST", url, bytes.NewReader(body))
  if err != nil {
    panic(err)
  }
  req.Header.Set("X-Apemesh-Key", "<用户appKey>")
  req.Header.Set("Content-Type", "application/json")

  client := &http.Client{}
  resp, err := client.Do(req)
  if err != nil {
      panic(err)
  }
  defer resp.Body.Close()

  responseBody, _ := ioutil.ReadAll(resp.Body)

  // 以下展示的是发送短信验证码API返回结果的output JSON对象的构建方法
  // 其他API的返回结果output JSON对象的构建方法请参照各自的API文档

  if (resp.StatusCode == 500) {
    type FaultInfo struct {
      Reason    string `json:"reason"`
      Info      string `json:"info"`
    }
    type ErrorInfo struct {
      Topic              string     `json:"topic"`
      Message            string     `json:"message"`
      Fault              FaultInfo  `json:"fault"`
    }

    var errorInfo = ErrorInfo{}
    json.Unmarshal(responseBody, &errorInfo)

    fmt.Println(errorInfo.Fault.Reason)
  } else {
    type OutputData struct {
      Result    string  `json:"result"`
      SmsID      string `json:"smsID"`
    }
    type ReturnData struct {
      Output    OutputData  `json:"output"`
    }

    var result = ReturnData{}
    json.Unmarshal(responseBody, &result)

    fmt.Println(result.Output.SmsID)
  }
}
