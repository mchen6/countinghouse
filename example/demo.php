<?php
    // 这里展示的是发送短信验证码API的input JSON对象的构建方法
    // 其他API的input JSON对象参数的构建方法请参照各自的API文档
    $postData = array(
        'serviceID' => 'urn:cdif-io:serviceID:短信服务',
        'actionName' => '发送验证码',
        'input' => array('phoneNum' => '13910001000', 'templateID' => '<模板ID>', 'content' => array('345756'))
    );

 
    $context = stream_context_create(array(
        'http' => array(
            'header' => "X-Apemesh-Key: <用户appKey>\r\n".
                        "Content-Type: application/json\r\n",
            'method' => 'POST',
            'content' => json_encode($postData),
            'ignore_errors' => true
        )
    ));
 
    // Send the request
    $response = file_get_contents('https://api.apemesh.com:3049/devices/f5dc73f9-b739-5ee2-add7-e499da04c6ec/invoke-action', FALSE, $context);
 
    // Check for errors
    if ($response === FALSE || json_decode($response, TRUE)['topic'] == 'device error') {
        var_dump($http_response_header);
        die(json_decode($response,TRUE)['fault']['reason']);
    }
 
    // Decode the response
    $responseData = json_decode($response, TRUE);
 
    // Print the date from the response
    print_r($responseData['output']);
 
?>
