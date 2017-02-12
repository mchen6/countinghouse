package main

import (
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
  var test = RequestData {
    ServiceID: "urn:cdif-io:serviceID:短信服务",
    ActionName: "发送验证码",
    InputData: Input{"13916381779", "d8df179735a0b249", []string{"123135"}},
  }
  body, err := json.Marshal(test)
  if err != nil {
    panic(err)
  }
  fmt.Println(string(body))
}


// func main() {
//     data := RequestData {
//         serviceID: "urn:cdif-io:serviceID:短信服务",
//         actionName: "发送验证码",
//         input:  Input {
//             phoneNum: "13916381779",
//             templateID: "d8df179735a0b249",
//             content: []string{"123456"},
//         },
//     }

//     b := new(bytes.Buffer)
//     json.NewEncoder(b).Encode(data)

//     fmt.Println(data)
// }